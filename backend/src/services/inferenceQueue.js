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
//   - closeQueue() drains everything for graceful shutdown.

const { Queue, Worker } = require('bullmq');
const ollamaService = require('./ollamaService');
const IORedis = require('ioredis');

const NODE_ENV = process.env.NODE_ENV || 'development';
const QUEUE_NAME = 'GemmaInferenceQueue';

let connection = null;
let queue = null;
let worker = null;
let workerStartPromise = null;

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
 * Enqueue an inference job. Returns the BullMQ job (with a working
 * waitUntilFinished()) in production; in no-Redis environments it runs the
 * generation inline and returns a lightweight stand-in with the same shape.
 */
async function addInferenceJob(prompt, contextStr) {
  const q = getQueue();
  if (!q) {
    const response = await ollamaService.generateResponse(prompt, contextStr);
    return {
      id: `inline_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      waitUntilFinished: async () => response
    };
  }
  const job = await q.add('generate', { prompt, contextStr });
  return job;
}

/**
 * Resolve a job for the polling endpoint. Inline (no-Redis) jobs are not
 * resolvable — getJob returns null and the route 404s.
 */
async function getJob(jobId) {
  const q = getQueue();
  if (!q || !jobId) return null;
  try {
    return await q.getJob(String(jobId));
  } catch (err) {
    console.error(`[QUEUE] getJob(${jobId}) failed:`, err.message);
    return null;
  }
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
 * Graceful shutdown: close worker, queue, and the shared connection.
 */
async function closeQueue() {
  try { if (worker) await worker.close(); } catch (_e) { /* ignore */ }
  try { if (queue) await queue.close(); } catch (_e) { /* ignore */ }
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
  startWorker,
  getQueueStatus,
  pingRedis,
  closeQueue
};
