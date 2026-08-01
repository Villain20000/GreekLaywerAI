const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const ragService = require('../services/ragService');
const documentService = require('../services/documentService');
const ollamaService = require('../services/ollamaService');
const inferenceQueue = require('../services/inferenceQueue');
const { rbacMiddleware } = require('../middlewares/authMiddleware');
const { requireTier } = require('../middlewares/tierMiddleware');
const { createAiRateLimiters } = require('../middlewares/rateLimiters');
const { validate, validateUploadedFile } = require('../middlewares/validation');
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
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

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
  async (req, res) => {
    try {
      const { prompt, useRag = true, conversationId, documentIds = [] } = req.body;
      const rag = useRag
        ? await retrieveRagContext(prompt, req.user.id, documentIds)
        : { contextStr: '', sources: [], confidence: 0 };

      // Phase 29: inference runs through the BullMQ queue (concurrency 1,
      // GPU protection). waitUntilFinished() blocks the HTTP request until
      // the worker stores the result — same response shape as before.
      const startedAt = Date.now();
      const job = await inferenceQueue.addInferenceJob(prompt, rag.contextStr, {
        userId: req.user.id,
        conversationId: conversationId || null,
        prompt,
        sources: rag.sources,
        confidence: rag.confidence
      });
      const queueEvents = inferenceQueue.getQueueEvents();
      const response = queueEvents
        ? await job.waitUntilFinished(queueEvents)
        : await job.waitUntilFinished();
      recordAiQueryDuration(Date.now() - startedAt);

      const messageId = await storeExchange(conversationId, req.user.id, prompt, response, job.id, {
        sources: rag.sources,
        confidence: rag.confidence
      });

      res.json({
        response,
        messageId,
        sources: rag.sources,
        confidence: rag.confidence
      });
    } catch (error) {
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
  async (req, res) => {
    try {
      const { prompt, useRag = true, conversationId, documentIds = [] } = req.body;
      const rag = useRag
        ? await retrieveRagContext(prompt, req.user.id, documentIds)
        : { contextStr: '', sources: [], confidence: 0 };

      const job = await inferenceQueue.addInferenceJob(prompt, rag.contextStr, {
        userId: req.user.id,
        conversationId: conversationId || null,
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
      const job = await inferenceQueue.getJob(req.params.jobId);
      if (!belongsToUser(job, req.user.id)) {
        return res.status(404).json({ error: 'Job not found' });
      }
      const state = await job.getState();
      if (state === 'completed') {
        const conversationId = job.data && job.data.conversationId;
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

// Phase 7: Audio Streaming Endpoint — premium (pro tier, role-gated)
router.post(
  '/audio-query',
  limiters.audioQuery,
  rbacMiddleware(['admin', 'enterprise']),
  requireTier('pro'),
  upload.single('audio'),
  validateUploadedFile('audio'),
  async (req, res) => {
    try {
      const audioBuffer = req.file.buffer;
      console.log(`Received audio clip of size ${audioBuffer.length} bytes (${req.file.detectedType})`);

      const mockTranscription = 'Τι προβλέπει ο νόμος για το δικαίωμα στην προσωπικότητα;';

      const rag = await retrieveRagContext(mockTranscription, req.user.id);

      const conversationId = req.body && req.body.conversationId;
      const job = await inferenceQueue.addInferenceJob(mockTranscription, rag.contextStr, {
        userId: req.user.id,
        conversationId: conversationId || null,
        prompt: mockTranscription,
        sources: rag.sources,
        confidence: rag.confidence
      });
      res.json({ jobId: job.id });
    } catch (error) {
      console.error('Audio query error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Multimodal Upload Endpoint — premium (enterprise tier, role-gated)
router.post(
  '/multimodal',
  limiters.multimodal,
  rbacMiddleware(['admin', 'enterprise']),
  requireTier('enterprise'),
  upload.single('file'),
  validateUploadedFile('multimodal'),
  async (req, res) => {
    try {
      const fileBuffer = req.file.buffer;
      console.log(`Received file of size ${fileBuffer.length} bytes, type: ${req.file.detectedType}`);

      const mockResponse =
        'Έχω αναλύσει το επισυναπτόμενο έγγραφο. Φαίνεται να είναι νομικό συμβόλαιο.';
      res.json({ response: mockResponse });
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
