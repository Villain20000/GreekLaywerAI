// Live (SSE) token streaming for the chat endpoint.
//
// POST /api/ai/query/live enqueues a normal inference job flagged
// `stream: true`. The existing concurrency-1 BullMQ worker (or the inline
// gate in no-Redis environments) keeps owning the GPU; it publishes model
// deltas to streamHub instead of only returning the final string.
//
// GET /api/ai/query/live/:jobId/events attaches to that job's channel and
// forwards `chunk` / `done` / `error` SSE events. The job must belong to
// req.user (same check as the polling endpoint) and must be a streaming job.
//
// AUTH: this router is mounted at `/api/ai` WITHOUT an outer authMiddleware
// and applies auth per route. It should be registered BEFORE the existing
// aiRoutes mount (whose mount-level auth would otherwise authenticate every
// `/query/live/*` request before this router sees it). The `authOnce` guard
// below additionally skips auth when req.user is already hydrated, so a
// mount registered after aiRoutes still authenticates exactly once.
//
// The legacy POST /query, POST /query/stream and GET polling endpoints stay
// untouched in routes/ai.js; this file only adds the live path.

const express = require('express');
const router = express.Router();
const inferenceQueue = require('../services/inferenceQueue');
const streamHub = require('../services/streamHub');
const aiRoutes = require('./ai');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const { enforceAiQuota } = require('../middlewares/quotaMiddleware');
const { createAiRateLimiters } = require('../middlewares/rateLimiters');

const AI_ROLES = ['user', 'admin', 'enterprise'];
const limiters = createAiRateLimiters();

const HEARTBEAT_MS = 15 * 1000;
// A slow DB must not delay the user-visible `done` event forever. The insert
// is idempotent, so the polling fallback can retry it later.
const PERSIST_TIMEOUT_MS = 5000;

// Exactly one auth pass per request: run authMiddleware unless a previous
// mount (e.g. the legacy aiRoutes mount) already populated req.user.
function authOnce(req, res, next) {
  if (req.user) return next();
  return authMiddleware(req, res, next);
}

function sseData(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * POST /query/live — same auth/RBAC/rate-limit/validation/quota pipeline as
 * POST /query/stream, but the job is flagged for token streaming.
 */
router.post(
  '/query/live',
  authOnce,
  limiters.stream,
  rbacMiddleware(AI_ROLES),
  aiRoutes.validatePrompt,
  enforceAiQuota,
  async (req, res) => {
    try {
      const { prompt, useRag = true, conversationId, documentIds = [] } = req.body;
      const parsedConversationId = aiRoutes.parseConversationId(conversationId);
      if (!parsedConversationId.ok) {
        return res.status(400).json({ error: 'conversationId must be a positive integer' });
      }
      const rag = useRag
        ? await aiRoutes.retrieveRagContext(prompt, req.user.id, documentIds)
        : { contextStr: '', sources: [], confidence: 0 };

      const job = await inferenceQueue.addInferenceJob(prompt, rag.contextStr, {
        userId: req.user.id,
        conversationId: parsedConversationId.value,
        prompt,
        stream: true,
        sources: rag.sources,
        confidence: rag.confidence
      });
      return res.json({ jobId: job.id });
    } catch (error) {
      console.error('AI live stream enqueue error:', error);
      return res.status(500).json({ error: error.message });
    }
  }
);

/**
 * GET /query/live/:jobId/events — Server-Sent Events for one job.
 *
 * Ownership is checked before any stream bytes are written, so a job id
 * belonging to another user can never leak chunks or results.
 */
router.get(
  '/query/live/:jobId/events',
  authOnce,
  limiters.poll,
  rbacMiddleware(AI_ROLES),
  async (req, res) => {
    const jobId = req.params.jobId;
    if (!aiRoutes.isValidJobId(jobId)) {
      return res.status(400).json({ error: 'Invalid job id' });
    }

    let job;
    try {
      job = await inferenceQueue.getJob(jobId);
    } catch (error) {
      console.error('AI live stream lookup error:', error);
      return res.status(500).json({ error: error.message });
    }
    if (!aiRoutes.belongsToUser(job, req.user.id) || !job.data || job.data.stream !== true) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');

    const parsedConversationId = aiRoutes.parseConversationId(job.data.conversationId);
    const conversationId = parsedConversationId.ok ? parsedConversationId.value : null;
    const prompt = typeof job.data.prompt === 'string' ? job.data.prompt : '';
    const ownerId = req.user.id;

    let closed = false;
    let unsubscribe = null;
    let heartbeat = null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        try { unsubscribe(); } catch (_err) { /* ignore */ }
        unsubscribe = null;
      }
    };

    const write = (event, payload) => {
      if (closed) return;
      try {
        res.write(sseData(event, payload));
      } catch (_err) {
        cleanup();
      }
    };

    const finish = () => {
      cleanup();
      if (!res.writableEnded) {
        try { res.end(); } catch (_err) { /* ignore */ }
      }
    };

    res.on('close', cleanup);
    req.on('aborted', cleanup);

    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(': heartbeat\n\n');
      } catch (_err) {
        cleanup();
      }
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const persistAnswer = async (result, sources, confidence) => {
      if (!conversationId) return null;
      let timer = null;
      try {
        return await Promise.race([
          aiRoutes.storeExchange(
            conversationId,
            ownerId,
            prompt,
            result,
            jobId,
            { sources, confidence }
          ),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), PERSIST_TIMEOUT_MS);
            if (typeof timer.unref === 'function') timer.unref();
          })
        ]);
      } catch (error) {
        // The answer is still delivered; the polling endpoint retries the
        // idempotent insert (unique source_job_id) if the client falls back.
        console.error(`[STREAM] persistence failed for job ${jobId}: ${error.message}`);
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    let handlingDone = false;
    const handleDone = async (payload) => {
      if (closed || handlingDone) return;
      handlingDone = true;
      const result = typeof payload.result === 'string' ? payload.result : '';
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const confidence = Number.isFinite(Number(payload.confidence))
        ? Number(payload.confidence)
        : 0;
      const messageId = await persistAnswer(result, sources, confidence);
      write('done', { result, messageId, sources, confidence });
      finish();
    };

    let state = 'active';
    try {
      if (typeof job.getState === 'function') state = await job.getState();
    } catch (_err) {
      // Treat an unreadable state as active; subscribing still replays any
      // terminal event the worker already published.
    }

    if (state === 'completed') {
      const result = typeof job.returnvalue === 'string' ? job.returnvalue : '';
      const sources = Array.isArray(job.data.sources) ? job.data.sources : [];
      const confidence = Number.isFinite(Number(job.data.confidence))
        ? Number(job.data.confidence)
        : 0;
      const messageId = await persistAnswer(result, sources, confidence);
      write('done', { result, messageId, sources, confidence });
      finish();
      return;
    }

    if (state === 'failed') {
      write('error', { error: job.failedReason || 'Job failed' });
      finish();
      return;
    }

    try {
      unsubscribe = await streamHub.subscribe(jobId, (event) => {
        if (event.type === 'chunk') {
          write('chunk', { content: event.content });
          return;
        }
        if (event.type === 'error') {
          write('error', { error: event.error || 'Inference stream failed' });
          finish();
          return;
        }
        if (event.type === 'done') {
          return handleDone(event);
        }
      });
    } catch (error) {
      console.error(`[STREAM] subscribe failed for job ${jobId}:`, error);
      write('error', { error: 'Stream unavailable' });
      finish();
      return;
    }

    if (closed) {
      try { unsubscribe(); } catch (_err) { /* ignore */ }
      unsubscribe = null;
    }
  }
);

module.exports = router;
