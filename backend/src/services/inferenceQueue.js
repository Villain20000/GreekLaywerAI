// Phase 16 + Phase 29: Inference Queue & Hardware Performance Control.
//
// Phase 29 changes:
//   - Lazy singleton Redis connection. In test env (NODE_ENV=test) or when
//     REDIS_URL is unset, the module connects to NOTHING and addInferenceJob
//     falls back to an inline synchronous call — dev/tests keep working
//     without Redis, while production gets the full queue.
//   - startWorker() is idempotent (singleton-promise pattern) and is called
//     from index.js on boot.
//   - getQueueStatus() feeds the /health endpoint.
//   - cited-answer metadata travels in job.data alongside the prompt/context.
//   - closeQueue() drains everything for graceful shutdown.
//
// 1-14 hardening:
//   - Inline results expire (INLINE_JOB_TTL_MS) and are pruned periodically
//     with an unref'd timer, so dev processes don't leak one Map entry per
//     completed query. A job's TTL restarts whenever getJob() polls it, so a
//     just-completed answer is never pruned out from under an active poll.
//   - Inline execution is gated by INLINE_QUEUE_CONCURRENCY (default 1), so
//     the no-Redis path protects a single local GPU exactly like the BullMQ
//     worker does.
//   - BullMQ jobs retry with exponential backoff, enqueue calls have a
//     timeout, completed/failed jobs are retained only briefly, and stalled
//     jobs have an explicit recovery policy.
//   - `inference_queue_depth` (prom-client, exported by middlewares/metrics)
//     tracks outstanding work for BOTH paths.

const { Queue, QueueEvents, Worker } = require('bullmq');
const ollamaService = require('./ollamaService');
const IORedis = require('ioredis');
const { inferenceQueueDepth } = require('../middlewares/metrics');

const NODE_ENV = process.env.NODE_ENV || 'development';
const QUEUE_NAME = 'GemmaInferenceQueue';

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

// Inline (no-Redis) retention + concurrency. TTL is measured from the later
// of completion and the last getJob() poll (see pruneInlineJobs).
const INLINE_JOB_TTL_MS = positiveInt(process.env.INLINE_JOB_TTL_MS, 10 * 60 * 1000);
const INLINE_JOB_PRUNE_INTERVAL_MS = Math.min(
  positiveInt(process.env.INLINE_JOB_PRUNE_INTERVAL_MS, Math.min(INLINE_JOB_TTL_MS, 60 * 1000)),
  INLINE_JOB_TTL_MS
);
const INLINE_QUEUE_CONCURRENCY = positiveInt(process.env.INLINE_QUEUE_CONCURRENCY, 1);

// BullMQ policy. All env-overridable so operators can tune without a code
// change; defaults match BullMQ's sane production values, except attempts
// (explicit retry budget) and retention (bounded Redis growth).
const QUEUE_ATTEMPTS = positiveInt(process.env.INFERENCE_QUEUE_ATTEMPTS, 3);
const QUEUE_BACKOFF_MS = positiveInt(process.env.INFERENCE_QUEUE_BACKOFF_MS, 1000);
const ENQUEUE_TIMEOUT_MS = positiveInt(process.env.INFERENCE_QUEUE_ENQUEUE_TIMEOUT_MS, 10000);
const REMOVE_ON_COMPLETE = positiveInt(process.env.INFERENCE_QUEUE_REMOVE_ON_COMPLETE, 1000);
const REMOVE_ON_FAIL = positiveInt(process.env.INFERENCE_QUEUE_REMOVE_ON_FAIL, 5000);
const MAX_STALLED_COUNT = positiveInt(process.env.INFERENCE_QUEUE_MAX_STALLED_COUNT, 1);
const LOCK_DURATION_MS = positiveInt(process.env.INFERENCE_QUEUE_LOCK_DURATION_MS, 300000);
const STALLED_INTERVAL_MS = positiveInt(process.env.INFERENCE_QUEUE_STALLED_INTERVAL_MS, 30000);

const JOB_OPTIONS = {
  attempts: QUEUE_ATTEMPTS,
  backoff: { type: 'exponential', delay: QUEUE_BACKOFF_MS },
  // Keep Redis bounded: retain at most N finished jobs, not forever.
  removeOnComplete: { count: REMOVE_ON_COMPLETE },
  removeOnFail: { count: REMOVE_ON_FAIL }
};

let connection = null;
let queue = null;
let queueEvents = null;
let worker = null;
let workerStartPromise = null;
// Inline jobs keep the no-Redis development path compatible with the same
// enqueue/poll contract used in production.
const inlineJobs = new Map();
let inlinePruneTimer = null;

// Inline concurrency gate. A single active job plus FIFO waiters mirrors the
// BullMQ worker's concurrency=1 GPU protection without Redis.
let inlineActive = 0;
const inlineWaiters = [];

// Local outstanding-work counter. `inference_queue_depth` is a process-local
// view (jobs added through this process and not yet completed/failed); it is
// deliberately unlabeled to stay low-cardinality.
let queueDepth = 0;

function setQueueDepth(next) {
  queueDepth = Math.max(0, next);
  try {
    inferenceQueueDepth.set(queueDepth);
  } catch (_err) {
    // Metrics must never break enqueue/worker paths.
  }
}

function adjustQueueDepth(delta) {
  setQueueDepth(queueDepth + delta);
}

function touchQueueDepth() {
  // Re-publish the current value on BullMQ's 'active' event. Starting a job
  // does not change outstanding depth (queued + running stays constant), but
  // this keeps the gauge fresh even if an external actor manipulated Redis.
  setQueueDepth(queueDepth);
}

setQueueDepth(0);

function ensureInlinePruneTimer() {
  if (inlinePruneTimer) return;
  inlinePruneTimer = setInterval(() => pruneInlineJobs(), INLINE_JOB_PRUNE_INTERVAL_MS);
  // Never keep the Node/Jest process alive just to prune a dev cache.
  if (typeof inlinePruneTimer.unref === 'function') inlinePruneTimer.unref();
}

/**
 * Drop completed inline results older than INLINE_JOB_TTL_MS. Uses the later
 * of completion time and last poll time so an actively polled job (or one
 * polled just before the sweep) keeps its answer.
 */
function pruneInlineJobs(now = Date.now()) {
  for (const [id, job] of inlineJobs) {
    const lastTouched = Math.max(job._completedAt || 0, job._lastAccessedAt || 0);
    if (now - lastTouched >= INLINE_JOB_TTL_MS) {
      inlineJobs.delete(id);
    }
  }
}

function acquireInlineSlot() {
  if (inlineActive < INLINE_QUEUE_CONCURRENCY) {
    inlineActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => inlineWaiters.push(resolve));
}

function releaseInlineSlot() {
  const next = inlineWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter; inlineActive is unchanged.
    next();
  } else {
    inlineActive = Math.max(0, inlineActive - 1);
  }
}

function withEnqueueTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Inference queue enqueue timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getConnection() {
  if (NODE_ENV === 'test') return null;
  if (!process.env.REDIS_URL) return null;
  if (connection) return connection;
  connection = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
  });
  connection.on('error', (err) => {
    console.error(`[QUEUE] Redis client error: ${err.message}`);
  });
  return connection;
}

function getQueue() {
  const conn = getConnection();
  if (!conn) return null;
  if (queue) return queue;
  queue = new Queue(QUEUE_NAME, { connection: conn });
  return queue;
}

/**
 * Lazy singleton QueueEvents instance. BullMQ >= 5.x requires an explicit
 * QueueEvents instance to be passed to Job.waitUntilFinished() — it is NOT
 * pulled from the queue object anymore.
 */
function getQueueEvents() {
  const conn = getConnection();
  if (!conn) return null;
  if (queueEvents) return queueEvents;
  queueEvents = new QueueEvents(QUEUE_NAME, { connection: conn });
  return queueEvents;
}

/**
 * Enqueue an inference job. Returns the BullMQ job (with a working
 * waitUntilFinished()) in production; in no-Redis environments it runs the
 * generation inline and returns a lightweight stand-in with the same shape.
 */
async function addInferenceJob(prompt, contextStr, metadata = {}) {
  const q = getQueue();
  if (!q) {
    const id = `inline_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    adjustQueueDepth(1);
    ensureInlinePruneTimer();
    await acquireInlineSlot();
    touchQueueDepth();
    try {
      const response = await ollamaService.generateResponse(prompt, contextStr);
      const now = Date.now();
      const job = {
        id,
        data: { prompt, contextStr, ...metadata },
        returnvalue: response,
        failedReason: null,
        _completedAt: now,
        _lastAccessedAt: now,
        waitUntilFinished: async () => response,
        getState: async () => 'completed'
      };
      inlineJobs.set(id, job);
      return job;
    } finally {
      adjustQueueDepth(-1);
      releaseInlineSlot();
    }
  }

  const job = await withEnqueueTimeout(
    q.add('generate', { prompt, contextStr, ...metadata }, JOB_OPTIONS),
    ENQUEUE_TIMEOUT_MS
  );
  adjustQueueDepth(1);
  return job;
}

/**
 * Resolve a job for the polling endpoint. Inline jobs are retained briefly
 * in memory so development uses the same ownership and polling contract as
 * the Redis-backed deployment.
 */
async function getJob(jobId) {
  if (!jobId) return null;
  const inlineJob = inlineJobs.get(String(jobId));
  if (inlineJob) {
    inlineJob._lastAccessedAt = Date.now();
    return inlineJob;
  }

  const q = getQueue();
  if (!q) return null;
  try {
    return await q.getJob(String(jobId));
  } catch (err) {
    console.error(`[QUEUE] getJob(${jobId}) failed:`, err.message);
    return null;
  }
}

/**
 * Best-effort cancellation for client disconnects. Waiting/delayed BullMQ
 * jobs can be removed; active local-model inference cannot be interrupted
 * safely through BullMQ alone, so it is reported as not removed.
 */
async function cancelJob(jobId) {
  if (!jobId) return false;
  if (inlineJobs.delete(String(jobId))) return true;

  const job = await getJob(jobId);
  if (!job) return false;
  try {
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      // No completed/failed event will fire for a removed waiting job.
      adjustQueueDepth(-1);
      return true;
    }
  } catch (err) {
    console.error(`[QUEUE] cancelJob(${jobId}) failed:`, err.message);
  }
  return false;
}

/**
 * Start the worker exactly once. Idempotent: concurrent / repeated calls
 * coalesce on the singleton promise. Concurrency stays 1 so the local GPU
 * is never overwhelmed by parallel 128K-context RAG queries.
 */
function startWorker() {
  const conn = getConnection();
  if (!conn || worker) return;
  if (workerStartPromise) return workerStartPromise;

  workerStartPromise = (async () => {
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        console.log(`[QUEUE] Processing inference job: ${job.id}`);
        const { prompt, contextStr } = job.data;
        try {
          const response = await ollamaService.generateResponse(prompt, contextStr);
          return response;
        } catch (err) {
          console.error(`[QUEUE] Job ${job.id} failed:`, err);
          throw err;
        }
      },
      {
        connection: conn,
        concurrency: 1,
        // Stalled-job policy: one recovery attempt, with a lock comfortably
        // longer than the stalled check so a slow CPU/GPU job is not stolen.
        maxStalledCount: MAX_STALLED_COUNT,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_INTERVAL_MS
      }
    );

    worker.on('active', () => {
      touchQueueDepth();
    });
    worker.on('completed', (job) => {
      adjustQueueDepth(-1);
      console.log(`[QUEUE] Job ${job.id} completed successfully.`);
    });
    worker.on('failed', (job, err) => {
      // 'failed' fires per attempt. Depth only drops when the job will not be
      // retried again; intermediate failures stay outstanding.
      const attempts = (job && job.opts && job.opts.attempts) || QUEUE_ATTEMPTS;
      const made = job && Number.isFinite(Number(job.attemptsMade))
        ? Number(job.attemptsMade)
        : attempts;
      if (made >= attempts) adjustQueueDepth(-1);
      console.error(`[QUEUE] Job ${job ? job.id : '?'} failed with error ${err.message}`);
    });
    console.log(
      `[QUEUE] Inference worker started (concurrency=1, attempts=${QUEUE_ATTEMPTS}, ` +
      `lock=${LOCK_DURATION_MS}ms, stalledInterval=${STALLED_INTERVAL_MS}ms).`
    );
  })();

  return workerStartPromise;
}

/**
 * Snapshot queue state for /health. Never throws — reports `enabled:false`
 * with a reason when Redis is missing or unreachable.
 */
async function getQueueStatus() {
  try {
    const q = getQueue();
    if (!q) {
      return { enabled: false, reason: NODE_ENV === 'test' ? 'test env' : 'REDIS_URL not set' };
    }
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount()
    ]);
    return { enabled: true, waiting, active, completed, failed, delayed };
  } catch (err) {
    return { enabled: false, reason: err.message };
  }
}

/**
 * PING the Redis connection. Returns latency in ms, or null if Redis is
 * not configured / unreachable. Feeds the /health endpoint.
 */
async function pingRedis() {
  const conn = getConnection();
  if (!conn) return null;
  const start = Date.now();
  try {
    await conn.ping();
    return Date.now() - start;
  } catch (_err) {
    return null;
  }
}

/**
 * Graceful shutdown: stop the inline prune timer, drop retained inline
 * results, reset the depth gauge, then close worker/queue/events/connection.
 */
async function closeQueue() {
  if (inlinePruneTimer) {
    clearInterval(inlinePruneTimer);
    inlinePruneTimer = null;
  }
  inlineJobs.clear();
  setQueueDepth(0);

  try { if (worker) await worker.close(); } catch (_e) { /* ignore */ }
  try { if (queue) await queue.close(); } catch (_e) { /* ignore */ }
  try { if (queueEvents) await queueEvents.close(); } catch (_e) { /* ignore */ }
  try {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  } catch (_e) { /* ignore */ }

  worker = null;
  queue = null;
  queueEvents = null;
  workerStartPromise = null;
}

module.exports = {
  addInferenceJob,
  getJob,
  cancelJob,
  getQueueEvents,
  startWorker,
  getQueueStatus,
  pingRedis,
  closeQueue
};
