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

const { Queue, QueueEvents, Worker } = require('bullmq');
const ollamaService = require('./ollamaService');
const IORedis = require('ioredis');

const NODE_ENV = process.env.NODE_ENV || 'development';
const QUEUE_NAME = 'GemmaInferenceQueue';

let connection = null;
let queue = null;
let queueEvents = null;
let worker = null;
let workerStartPromise = null;
// Inline jobs keep the no-Redis development path compatible with the same
// enqueue/poll contract used in production.
const inlineJobs = new Map();

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
    const response = await ollamaService.generateResponse(prompt, contextStr);
    const id = `inline_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const job = {
      id,
      data: { prompt, contextStr, ...metadata },
      returnvalue: response,
      failedReason: null,
      waitUntilFinished: async () => response,
      getState: async () => 'completed'
    };
    inlineJobs.set(id, job);
    return job;
  }
  const job = await q.add('generate', { prompt, contextStr, ...metadata });
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
  if (inlineJob) return inlineJob;

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
      { connection: conn, concurrency: 1 }
    );

    worker.on('completed', (job) => {
      console.log(`[QUEUE] Job ${job.id} completed successfully.`);
    });
    worker.on('failed', (job, err) => {
      console.error(`[QUEUE] Job ${job ? job.id : '?'} failed with error ${err.message}`);
    });
    console.log('[QUEUE] Inference worker started (concurrency=1).');
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
 * Graceful shutdown: close worker, queue, events, and the shared connection.
 */
async function closeQueue() {
  try { if (worker) await worker.close(); } catch (_e) { /* ignore */ }
  try { if (queue) await queue.close(); } catch (_e) { /* ignore */ }
  try { if (queueEvents) await queueEvents.close(); } catch (_e) { /* ignore */ }
  inlineJobs.clear();
  try {
    if (connection) {
      connection.disconnect();
      connection = null;
    }
  } catch (_e) { /* ignore */ }
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
