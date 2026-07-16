// Phase 16: Inference Queue & Hardware Performance Control
const { Queue, Worker } = require('bullmq');
const ollamaService = require('./ollamaService');
const IORedis = require('ioredis');

// Ensure Redis connection
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
});

// Setup the Queue
const inferenceQueue = new Queue('GemmaInferenceQueue', { connection });

// Setup the Worker
// We limit concurrency to 1 so the local GPU isn't overwhelmed by massive 128K context RAG queries
const worker = new Worker('GemmaInferenceQueue', async job => {
  console.log(`[QUEUE] Processing inference job: ${job.id}`);
  const { prompt, contextStr } = job.data;
  
  try {
    const response = await ollamaService.generateResponse(prompt, contextStr);
    return response;
  } catch (err) {
    console.error(`[QUEUE] Job ${job.id} failed:`, err);
    throw err;
  }
}, { 
  connection,
  concurrency: 1 
});

worker.on('completed', job => {
  console.log(`[QUEUE] Job ${job.id} completed successfully.`);
});

worker.on('failed', (job, err) => {
  console.error(`[QUEUE] Job ${job.id} failed with error ${err.message}`);
});

async function addInferenceJob(prompt, contextStr) {
  const job = await inferenceQueue.add('generate', { prompt, contextStr });
  return job;
}

module.exports = {
  addInferenceJob,
  inferenceQueue
};
