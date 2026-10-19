const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const ragService = require('../services/ragService');
const documentService = require('../services/documentService');
const ollamaService = require('../services/ollamaService');
const transcriptionService = require('../services/transcriptionService');
const inferenceQueue = require('../services/inferenceQueue');
const { rbacMiddleware } = require('../middlewares/authMiddleware');
const { requireTier } = require('../middlewares/tierMiddleware');
const { enforceAiQuota } = require('../middlewares/quotaMiddleware');
const { createAiRateLimiters } = require('../middlewares/rateLimiters');
const { validate, validateUploadedFile, sniffFileType } = require('../middlewares/validation');
const { check } = require('express-validator');
const { recordAiQueryDuration } = require('../middlewares/metrics');

// Tier-aware rate limits (Phase 29): 20/60/120 per min for basic/pro/
// enterprise on query+stream; 5/min audio; 10/min multimodal; 120/min poll.
const limiters = createAiRateLimiters();

// Multer setup for handling multimodal inputs (PDFs, Images, Audio).
// 25 MB cap to mitigate trivial DoS on premium endpoints. File TYPE is
// validated by magic bytes in validateUploadedFile (Phase 29) — the multer
// `fileFilter` here only enforces per-endpoint size caps, because multer
// receives the stream before the buffer exists.
// Phase 1-2: the cap is env-overridable (AI_UPLOAD_MAX_BYTES) so tests can
// exercise the LIMIT_FILE_SIZE → 413 path without pushing 25 MB of bytes.
const storage = multer.memoryStorage();
const UPLOAD_MAX_BYTES = (() => {
  const parsed = Number(process.env.AI_UPLOAD_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 25 * 1024 * 1024;
})();
const upload = multer({
  storage: storage,
  limits: { fileSize: UPLOAD_MAX_BYTES }
});

// Phase 1-2: conversationId is persisted into an integer FK column, and a
// non-numeric value ('abc', 1e30, …) would otherwise reach Postgres and blow
// up with 22P02 (invalid_text_representation) → 500. Normalize at the edge so
// callers get a 400 instead. Absent/null/'' means "do not persist".
function parseConversationId(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  // Number.isSafeInteger also rejects 1e30-style floats that pg would send as
  // "1e+30" and Postgres would reject with another 22P02.
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, value: null };
  return { ok: true, value };
}

// BullMQ job ids are opaque strings (custom ids are allowed), so they are not
// integer-validated like conversationId — but keep them bounded so a
// pathological path segment can never be used as a Redis key bomb.
const MAX_JOB_ID_LENGTH = 128;

function isValidJobId(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_JOB_ID_LENGTH;
}

// Phase 1-2: cap the synchronous /query wait on the inference queue so a stuck
// worker cannot hold the HTTP request open forever. Env-overridable
// (AI_QUERY_TIMEOUT_MS) because a cold model load on slow hardware can
// legitimately take minutes.
const DEFAULT_QUERY_TIMEOUT_MS = 120000;

function getQueryTimeoutMs() {
  const parsed = Number(process.env.AI_QUERY_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_QUERY_TIMEOUT_MS;
}

function inferenceTimeoutError(timeoutMs) {
  const error = new Error(`Inference timed out after ${timeoutMs} ms`);
  error.code = 'AI_QUERY_TIMEOUT';
  return error;
}

/**
 * Await a job's result with a hard upper bound. The loser promise stays
 * pending (the worker may still finish and store the result for the polling
 * fallback), but the HTTP request is released with a 504 marker error.
 */
async function waitUntilFinished(job, queueEvents) {
  const timeoutMs = getQueryTimeoutMs();
  let timer = null;
  try {
    return await Promise.race([
      queueEvents ? job.waitUntilFinished(queueEvents) : job.waitUntilFinished(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(inferenceTimeoutError(timeoutMs)), timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Prompt validation shared by /query and /query/stream.
const validatePrompt = validate([
  check('prompt')
    .isString()
    .withMessage('prompt must be a string')
    .trim()
    .notEmpty()
    .withMessage('prompt is required')
    .isLength({ max: 10000 })
    .withMessage('prompt must be at most 10000 characters')
]);

// Retrieval stays synchronous — only inference goes through the queue. Uploaded
// documents are always scoped again in documentService by owner, so a forged
// document id can never expose another user's chunks.
async function retrieveRagContext(prompt, userId, documentIds = []) {
  const legislation = await ragService.retrieveContext(prompt);
  const selectedIds = Array.isArray(documentIds)
    ? documentIds.filter((id) => Number.isInteger(id) && id > 0).slice(0, 10)
    : [];
  const uploaded = selectedIds.length
    ? await documentService.searchUserDocuments(prompt, userId, 5, selectedIds)
    : [];
  const documents = [...legislation, ...uploaded];
  const sources = ragService.toSources(documents);
  return {
    contextStr: ragService.formatContextForGemma(documents),
    sources,
    confidence: ragService.calculateConfidence(sources)
  };
}

/**
 * Optionally persist a user/assistant exchange into a conversation.
 * Silently skips if conversationId is missing or does not belong to the
 * user (defensive — the AI answer is not blocked by history storage).
 */
async function storeExchange(conversationId, userId, prompt, response, jobId = null, answerMetadata = {}) {
  if (!conversationId) return;
  const conv = await db.query(
    `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (conv.rows.length === 0) return;

  if (jobId) {
    // The assistant row owns the unique job key. Inserting both rows in one
    // CTE makes retries atomic: a second poll inserts neither row, while a
    // first poll cannot leave a user message behind without its answer.
    // The user timestamp is slightly earlier so normal chronological reads
    // still show user → assistant even though the CTE reserves the key first.
    const result = await db.query(
      `WITH inserted_assistant AS (
         INSERT INTO messages (conversation_id, role, content, source_job_id, citation_metadata, created_at)
         VALUES ($1, 'assistant', $3, $4, $5::jsonb, CURRENT_TIMESTAMP)
         ON CONFLICT (source_job_id) WHERE source_job_id IS NOT NULL DO NOTHING
         RETURNING id
       ), inserted_user AS (
         INSERT INTO messages (conversation_id, role, content, source_job_id, citation_metadata, created_at)
         SELECT $1, 'user', $2, NULL, NULL, CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
         WHERE EXISTS (SELECT 1 FROM inserted_assistant)
         RETURNING id
       )
       existing_assistant AS (
         SELECT id
         FROM messages
         WHERE source_job_id = $4
           AND conversation_id = $1
           AND role = 'assistant'
       ), touched_conversation AS (
         UPDATE conversations
         SET updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND EXISTS (SELECT 1 FROM inserted_assistant)
         RETURNING id
       )
       SELECT inserted_assistant.id AS assistant_message_id
       FROM inserted_assistant
       JOIN touched_conversation ON TRUE
       UNION ALL
       SELECT existing_assistant.id AS assistant_message_id
       FROM existing_assistant
       WHERE NOT EXISTS (SELECT 1 FROM inserted_assistant)`,
      [conversationId, prompt, String(response), String(jobId), JSON.stringify(answerMetadata || {})]
    );
    return result.rows?.[0]?.assistant_message_id ?? null;
  }

  const inserted = await db.query(
    `INSERT INTO messages (conversation_id, role, content, source_job_id, citation_metadata)
     VALUES ($1, 'user', $2, NULL, NULL), ($1, 'assistant', $3, NULL, $4::jsonb)
     RETURNING id, role`,
    [conversationId, prompt, String(response), JSON.stringify(answerMetadata || {})]
  );
  await db.query(
    `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [conversationId]
  );
  return inserted.rows?.find((row) => row.role === 'assistant')?.id ?? null;
}

function belongsToUser(job, userId) {
  const jobUserId = job && job.data && Number(job.data.userId);
  return Boolean(job && Number.isInteger(jobUserId) && jobUserId === Number(userId));
}

// AI tiers:
//   user | admin | enterprise => basic chat (enqueued inference)
//   pro+ tier (role-gated)     => premium multimodal/audio
router.post(
  '/query',
  limiters.query,
  rbacMiddleware(['user', 'admin', 'enterprise']),
  validatePrompt,
  enforceAiQuota,
  async (req, res) => {
    try {
      const { prompt, useRag = true, conversationId, documentIds = [] } = req.body;
      const parsedConversationId = parseConversationId(conversationId);
      if (!parsedConversationId.ok) {
        return res.status(400).json({ error: 'conversationId must be a positive integer' });
      }
      const rag = useRag
        ? await retrieveRagContext(prompt, req.user.id, documentIds)
        : { contextStr: '', sources: [], confidence: 0 };

      // Phase 29: inference runs through the BullMQ queue (concurrency 1,
      // GPU protection). waitUntilFinished() blocks the HTTP request until
      // the worker stores the result — same response shape as before.
      // Phase 1-2: the wait is capped (504 on expiry, see waitUntilFinished).
      const startedAt = Date.now();
      const job = await inferenceQueue.addInferenceJob(prompt, rag.contextStr, {
        userId: req.user.id,
        conversationId: parsedConversationId.value,
        prompt,
        sources: rag.sources,
        confidence: rag.confidence
      });
      const queueEvents = inferenceQueue.getQueueEvents();
      const response = await waitUntilFinished(job, queueEvents);
      recordAiQueryDuration(Date.now() - startedAt);

      const messageId = await storeExchange(
        parsedConversationId.value,
        req.user.id,
        prompt,
        response,
        job.id,
        {
          sources: rag.sources,
          confidence: rag.confidence
        }
      );

      res.json({
        response,
        messageId,
        sources: rag.sources,
        confidence: rag.confidence
      });
    } catch (error) {
      if (error && error.code === 'AI_QUERY_TIMEOUT') {
        console.error('AI query timeout:', error.message);
        return res.status(504).json({ error: error.message });
      }
      console.error('AI query error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Phase 29: streaming endpoint now enqueues a job and returns its ID.
// The frontend polls GET /api/ai/query/stream/:jobId until the worker
// completes, then reads the result. RAG stays synchronous.
router.post(
  '/query/stream',
  limiters.stream,
  rbacMiddleware(['user', 'admin', 'enterprise']),
  validatePrompt,
  enforceAiQuota,
  async (req, res) => {
    try {
      const { prompt, useRag = true, conversationId, documentIds = [] } = req.body;
      const parsedConversationId = parseConversationId(conversationId);
      if (!parsedConversationId.ok) {
        return res.status(400).json({ error: 'conversationId must be a positive integer' });
      }
      const rag = useRag
        ? await retrieveRagContext(prompt, req.user.id, documentIds)
        : { contextStr: '', sources: [], confidence: 0 };

      const job = await inferenceQueue.addInferenceJob(prompt, rag.contextStr, {
        userId: req.user.id,
        conversationId: parsedConversationId.value,
        prompt,
        sources: rag.sources,
        confidence: rag.confidence
      });
      res.json({ jobId: job.id });
    } catch (error) {
      console.error('AI stream enqueue error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Job-status polling endpoint.
//   - waiting|active  → still processing
//   - completed       → { status, result }
//   - failed          → { status, error }
//   - unknown id      → 404
router.get(
  '/query/stream/:jobId',
  limiters.poll,
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      if (!isValidJobId(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }
      const job = await inferenceQueue.getJob(req.params.jobId);
      if (!belongsToUser(job, req.user.id)) {
        return res.status(404).json({ error: 'Job not found' });
      }
      const state = await job.getState();
      if (state === 'completed') {
        // Defensive normalization: the job data was validated at enqueue time,
        // but a malformed historical payload must never reach Postgres as-is.
        const parsedConversationId = parseConversationId(job.data && job.data.conversationId);
        const conversationId = parsedConversationId.ok ? parsedConversationId.value : null;
        const answerMetadata = {
          sources: Array.isArray(job.data && job.data.sources) ? job.data.sources : [],
          confidence: Number.isFinite(Number(job.data && job.data.confidence))
            ? Number(job.data.confidence)
            : 0
        };
        let messageId = null;
        if (conversationId) {
          messageId = await storeExchange(
            conversationId,
            req.user.id,
            job.data.prompt,
            job.returnvalue,
            req.params.jobId,
            answerMetadata
          );
        }
        return res.json({
          status: 'completed',
          result: job.returnvalue,
          messageId,
          sources: answerMetadata.sources,
          confidence: answerMetadata.confidence
        });
      }
      if (state === 'failed') {
        return res.json({ status: 'failed', error: job.failedReason || 'Job failed' });
      }
      return res.json({ status: state === 'waiting' || state === 'delayed' ? 'waiting' : 'active' });
    } catch (error) {
      console.error('AI poll error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Submit or replace the current user's feedback for an assistant answer.
// Message ownership is checked through the parent conversation, and user
// messages / other users' messages are deliberately indistinguishable from
// missing IDs to avoid turning this endpoint into an oracle.
router.post(
  '/messages/:messageId/feedback',
  limiters.feedback,
  rbacMiddleware(['user', 'admin', 'enterprise']),
  validate([
    check('helpful').isBoolean().withMessage('helpful must be a boolean'),
    check('reason').optional({ values: 'null' }).isString().trim().isLength({ max: 500 })
  ]),
  async (req, res) => {
    try {
      const rawMessageId = String(req.params.messageId || '');
      const messageId = Number(rawMessageId);
      if (!/^\d+$/.test(rawMessageId) || !Number.isSafeInteger(messageId) || messageId <= 0) {
        return res.status(400).json({ error: 'Invalid message id' });
      }

      const ownedAnswer = await db.query(
        `SELECT m.id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`,
        [messageId, req.user.id]
      );
      if (ownedAnswer.rows.length === 0) {
        return res.status(404).json({ error: 'Assistant message not found' });
      }

      const result = await db.query(
        `INSERT INTO message_feedback (message_id, user_id, helpful, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id, user_id) DO UPDATE
         SET helpful = EXCLUDED.helpful,
             reason = EXCLUDED.reason,
             updated_at = CURRENT_TIMESTAMP
         RETURNING id, message_id, user_id, helpful, reason, created_at, updated_at`,
        [messageId, req.user.id, req.body.helpful, req.body.reason || null]
      );
      return res.json({ feedback: result.rows[0] });
    } catch (error) {
      console.error('AI feedback error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// Best-effort cancellation for a user's own queued inference job. Active
// local-model work cannot be interrupted safely, but waiting jobs are removed.
router.delete(
  '/query/stream/:jobId',
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      if (!isValidJobId(req.params.jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }
      const job = await inferenceQueue.getJob(req.params.jobId);
      if (!belongsToUser(job, req.user.id)) {
        return res.status(404).json({ error: 'Job not found' });
      }
      const removed = await inferenceQueue.cancelJob(req.params.jobId);
      return res.json({ ok: true, removed });
    } catch (error) {
      console.error('AI cancel error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

// Phase 7: Audio Streaming Endpoint — premium (pro tier or higher).
// Tier (not role) is the gate: paid pro/enterprise accounts carry
// role='user' and would otherwise be rejected by an RBAC role check before
// requireTier ever ran. requireTier runs before the upload so unauthorized
// callers never stream bytes into memory.
router.post(
  '/audio-query',
  limiters.audioQuery,
  requireTier('pro'),
  enforceAiQuota,
  upload.single('audio'),
  validateUploadedFile('audio'),
  async (req, res) => {
    try {
      const audioBuffer = req.file.buffer;
      console.log(`Received audio clip of size ${audioBuffer.length} bytes (${req.file.detectedType})`);

      // Phase 1-6: real STT via the local whisper sidecar (privacy-preserving
      // — audio never leaves the deployment). The transcript becomes the
      // inference prompt, so the rest of the flow (RAG → queued inference →
      // poll) is unchanged.
      const transcription = await transcriptionService.transcribe(audioBuffer, {
        mimeType: req.file.detectedType
      });
      // Log the size only — the spoken content may be privileged.
      console.log(`Transcribed ${audioBuffer.length} audio bytes to ${transcription.length} chars`);

      const rag = await retrieveRagContext(transcription, req.user.id);

      const conversationId = parseConversationId(req.body && req.body.conversationId);
      if (!conversationId.ok) {
        return res.status(400).json({ error: 'conversationId must be a positive integer' });
      }
      const job = await inferenceQueue.addInferenceJob(transcription, rag.contextStr, {
        userId: req.user.id,
        conversationId: conversationId.value,
        prompt: transcription,
        sources: rag.sources,
        confidence: rag.confidence
      });
      res.json({ jobId: job.id });
    } catch (error) {
      if (error instanceof transcriptionService.TranscriptionError) {
        console.error(`Audio transcription failed (${error.code}):`, error.message);
        return res.status(error.status).json({ error: error.publicMessage });
      }
      console.error('Audio query error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Multimodal Upload Endpoint — premium (enterprise tier or higher).
// Same tier-not-role rationale as /audio-query above.
//
// Phase 1-7: real document handling. PDF and DOCX are text-extracted through
// the shared document pipeline (documentService.extractMetadata — the same
// parser processAndStoreDocument uses) and then answered with the normal
// RAG + local-LLM path. Vision is out of scope by decision (2026-10-18):
// images get an explicit "not supported" envelope instead of a canned reply.
const MULTIMODAL_DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
];
// Prompt char budget: enough for a multi-page contract excerpt while keeping
// the local model's context window + latency bounded.
const MULTIMODAL_DOCUMENT_MAX_CHARS = 8000;

// The shared validateUploadedFile('multimodal') whitelist predates DOCX
// support and rejects it before the handler can see the bytes, so the route
// sniffs with the same dependency-free magic-byte helper instead:
//   - unrecognizable bytes        → 400 (validateUploadedFile's convention)
//   - recognized, but not PDF/DOCX (images, plain text, …) → 415 below
function validateMultimodalUpload(req, res, next) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const detectedType = sniffFileType(req.file.buffer);
  if (!detectedType) {
    return res.status(400).json({
      error: `Unsupported file type. Allowed: ${MULTIMODAL_DOCUMENT_TYPES.join(', ')}`
    });
  }
  // Strip path components so a crafted multipart name can never traverse
  // directories downstream (same sanitization as validateUploadedFile).
  if (req.file.originalname) {
    req.file.originalname = req.file.originalname.replace(/[\\/]/g, '_');
  }
  req.file.detectedType = detectedType;
  next();
}

router.post(
  '/multimodal',
  limiters.multimodal,
  requireTier('enterprise'),
  enforceAiQuota,
  upload.single('file'),
  validateMultimodalUpload,
  async (req, res) => {
    try {
      const detectedType = req.file.detectedType;
      if (!MULTIMODAL_DOCUMENT_TYPES.includes(detectedType)) {
        return res.status(415).json({
          error: 'Unsupported media type. Upload a PDF or DOCX document.'
        });
      }

      const { text } = await documentService.extractMetadata(req.file.buffer, {
        contentType: detectedType,
        filename: req.file.originalname
      });
      const excerpt = typeof text === 'string' ? text.trim().slice(0, MULTIMODAL_DOCUMENT_MAX_CHARS) : '';
      if (!excerpt) {
        // Scanned/image-only PDFs have no text layer — say so instead of
        // letting the model invent a summary of an empty context.
        return res.status(422).json({ error: 'Could not extract text from the document' });
      }
      console.log(
        `Multimodal document of ${req.file.buffer.length} bytes (${detectedType}) → ${excerpt.length} prompt chars`
      );

      // The attached document is the question; retrieved legislation is the
      // grounding context (same Greek prompt shape as the chat routes).
      const prompt = [
        'Ανέλυσε το ακόλουθο νομικό έγγραφο που επισύναψε ο χρήστης και απάντησε με βάση το περιεχόμενό του.',
        'Σχολίασε τα βασικά νομικά σημεία, τις υποχρεώσεις και τυχόν κινδύνους που προκύπτουν.',
        '',
        'Περιεχόμενο εγγράφου:',
        excerpt
      ].join('\n');

      const rag = await retrieveRagContext(excerpt, req.user.id);
      const response = await ollamaService.generateResponse(prompt, rag.contextStr);

      res.json({ response, sources: rag.sources, confidence: rag.confidence });
    } catch (error) {
      console.error('Multimodal error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Expose a minimal text endpoint for direct (non-streaming) generation —
// used by tooling / tests.
router.get('/models', (req, res) => {
  res.json({
    chatModel: ollamaService.getWarmupStatus().chatModel,
    embedModel: ollamaService.getWarmupStatus().embedModel,
    embedDim: ollamaService.getWarmupStatus().embedDim
  });
});

module.exports = router;
