const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const ragService = require('../services/ragService');
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

// RAG retrieval stays synchronous — only inference goes through the queue.
async function retrieveRagContext(prompt) {
  const docs = await ragService.retrieveContext(prompt);
  return ragService.formatContextForGemma(docs);
}

/**
 * Optionally persist a user/assistant exchange into a conversation.
 * Silently skips if conversationId is missing or does not belong to the
 * user (defensive — the AI answer is not blocked by history storage).
 */
async function storeExchange(conversationId, userId, prompt, response) {
  if (!conversationId) return;
  const conv = await db.query(
    `SELECT id FROM conversations WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  if (conv.rows.length === 0) return;
  await db.query(
    `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
    [conversationId, prompt, String(response)]
  );
  await db.query(
    `UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [conversationId]
  );
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
      const { prompt, useRag = true, conversationId } = req.body;
      const contextStr = useRag ? await retrieveRagContext(prompt) : '';

      // Phase 29: inference runs through the BullMQ queue (concurrency 1,
      // GPU protection). waitUntilFinished() blocks the HTTP request until
      // the worker stores the result — same response shape as before.
      const startedAt = Date.now();
      const job = await inferenceQueue.addInferenceJob(prompt, contextStr);
      const response = await job.waitUntilFinished();
      recordAiQueryDuration(Date.now() - startedAt);

      await storeExchange(conversationId, req.user.id, prompt, response);

      res.json({ response });
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
      const { prompt, useRag = true } = req.body;
      const contextStr = useRag ? await retrieveRagContext(prompt) : '';

      const job = await inferenceQueue.addInferenceJob(prompt, contextStr);
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
      if (!job) {
        return res.status(404).json({ error: 'Job not found' });
      }
      const state = await job.getState();
      if (state === 'completed') {
        return res.json({ status: 'completed', result: job.returnvalue });
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

      const contextStr = await retrieveRagContext(mockTranscription);

      const job = await inferenceQueue.addInferenceJob(mockTranscription, contextStr);
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
