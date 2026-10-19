// Dedicated BullMQ worker entrypoint for multi-replica deployments.
//
// Web replicas set QUEUE_WORKER_ENABLED=false; exactly one worker pod runs
// this script so the local/Ollama GPU never processes more than one
// inference at a time. Redis pub/sub carries live token streams back to the
// web replicas serving the SSE connections.
require('dotenv').config();

require('./config/sentry').initSentry();
const inferenceQueue = require('./services/inferenceQueue');

inferenceQueue.startWorker();
console.log('[WORKER] Queue worker process started');

// Keep the container alive even if Redis is unavailable; the container
// runtime will surface the failed readiness state via logs.
const keepAlive = setInterval(() => {}, 60 * 1000);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[WORKER] ${signal} received — closing queue`);
  clearInterval(keepAlive);
  const forceExit = setTimeout(() => process.exit(1), 30000);
  forceExit.unref();
  try {
    await inferenceQueue.closeQueue();
  } catch (err) {
    console.error(`[WORKER] Shutdown error: ${err.message}`);
  }
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
