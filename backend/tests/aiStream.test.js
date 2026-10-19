// Live SSE token streaming route tests.
//
// The queue and DB are mocked (no Redis / Postgres), while streamHub runs in
// its in-process fallback. This exercises the real router, middleware chain,
// SSE framing, ownership checks and the idempotent storeExchange call.

process.env.NODE_ENV = 'test';

const express = require('express');
const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../src/services/ollamaService', () => ({
  generateResponse: jest.fn(),
  generateResponseStream: jest.fn(),
  generateEmbedding: jest.fn(),
  getWarmupStatus: jest.fn().mockReturnValue({
    chatModel: 'gemma:2b',
    embedModel: 'bge-m3',
    embedDim: 1024
  })
}));

jest.mock('../src/services/ragService', () => ({
  retrieveContext: jest.fn().mockResolvedValue([]),
  formatContextForGemma: jest.fn().mockReturnValue(''),
  toSources: jest.fn().mockReturnValue([]),
  calculateConfidence: jest.fn().mockReturnValue(0)
}));

jest.mock('../src/services/inferenceQueue', () => ({
  addInferenceJob: jest.fn(),
  getJob: jest.fn(),
  cancelJob: jest.fn().mockResolvedValue(false),
  getQueueEvents: jest.fn().mockReturnValue(null),
  startWorker: jest.fn(),
  getQueueStatus: jest.fn().mockResolvedValue({ enabled: false, reason: 'test env' }),
  pingRedis: jest.fn().mockResolvedValue(null),
  closeQueue: jest.fn().mockResolvedValue(undefined)
}));

const db = require('../src/config/db');
const inferenceQueue = require('../src/services/inferenceQueue');
const streamHub = require('../src/services/streamHub');
const aiStreamRoutes = require('../src/routes/aiStream');
const aiRoutes = require('../src/routes/ai');
const { authMiddleware } = require('../src/middlewares/authMiddleware');

const JWT_SECRET = 'nomos-super-secret-key-development';
const USER = {
  id: 2,
  email: 'user@nomos.ai',
  role: 'user',
  subscription_tier: 'basic',
  created_at: new Date('2026-01-01T00:00:00Z'),
  token_version: 1,
  verified_at: new Date('2026-01-01T00:00:00Z')
};
const SOURCE = { type: 'legislation', id: 7, title: 'Αστικός Κώδικας', similarity: 0.8 };

const app = express();
app.use(express.json());
// Mirrors the production ordering: the live router is mounted BEFORE the
// legacy ai router so its per-route auth is the only auth that runs.
app.use('/api/ai', aiStreamRoutes);
app.use('/api/ai', authMiddleware, aiRoutes);

let server;
let port;

function tokenFor(id = USER.id) {
  return jwt.sign({ id, role: 'user', tv: 1 }, JWT_SECRET);
}

function wireDb() {
  db.query.mockImplementation(async (sql) => {
    if (typeof sql !== 'string') return { rows: [] };
    if (sql.includes('SELECT id, email, role')) return { rows: [USER] };
    if (sql.includes('INSERT INTO usage_counters')) return { rows: [{ count: 1 }] };
    if (sql.includes('SELECT id FROM conversations')) return { rows: [{ id: 5 }] };
    if (sql.includes('WITH inserted_assistant')) return { rows: [{ assistant_message_id: 99 }] };
    return { rows: [] };
  });
}

function authSelectCount() {
  return db.query.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && sql.includes('SELECT id, email, role')
  ).length;
}

function streamingJob(overrides = {}) {
  const data = {
    userId: USER.id,
    conversationId: 5,
    prompt: 'Ερώτηση;',
    stream: true,
    sources: [SOURCE],
    confidence: 0.8,
    ...overrides.data
  };
  const job = {
    id: overrides.id || 'live-job-1',
    data,
    returnvalue: overrides.returnvalue ?? null,
    failedReason: overrides.failedReason ?? null,
    getState: jest.fn().mockResolvedValue(overrides.state || 'active')
  };
  return job;
}

/**
 * Open an SSE request and resolve as soon as response headers arrive. The
 * returned bodyPromise resolves with the complete event stream when the
 * server ends the response.
 */
function openEventStream(jobId, token = tokenFor()) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/ai/query/live/${jobId}/events`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream'
        }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        const bodyPromise = new Promise((resEnd, rejectEnd) => {
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resEnd(body));
          res.on('error', rejectEnd);
        });
        resolve({ res, req, bodyPromise });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await streamHub.close();
});

beforeEach(() => {
  db.query.mockReset();
  wireDb();
  inferenceQueue.addInferenceJob.mockReset();
  inferenceQueue.getJob.mockReset();
});

describe('POST /api/ai/query/live', () => {
  it('enqueues a streaming job for the authenticated user and authenticates once', async () => {
    inferenceQueue.addInferenceJob.mockResolvedValueOnce({ id: 'live-job-1' });

    const res = await request(app)
      .post('/api/ai/query/live')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ prompt: 'Τι λέει ο ΑΚ 7;', conversationId: 5 });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ jobId: 'live-job-1' });
    expect(inferenceQueue.addInferenceJob).toHaveBeenCalledTimes(1);
    const [prompt, contextStr, metadata] = inferenceQueue.addInferenceJob.mock.calls[0];
    expect(prompt).toBe('Τι λέει ο ΑΚ 7;');
    expect(contextStr).toBe('');
    expect(metadata).toMatchObject({
      userId: USER.id,
      conversationId: 5,
      stream: true
    });
    // Mounted before the legacy router, per-route auth runs exactly once.
    expect(authSelectCount()).toBe(1);
  });

  it('authenticates exactly once even if the router is mounted after aiRoutes', async () => {
    const lateApp = express();
    lateApp.use(express.json());
    lateApp.use('/api/ai', authMiddleware, aiRoutes);
    lateApp.use('/api/ai', aiStreamRoutes);
    inferenceQueue.addInferenceJob.mockResolvedValueOnce({ id: 'late-job' });

    const res = await request(lateApp)
      .post('/api/ai/query/live')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ prompt: 'ερώτηση' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ jobId: 'late-job' });
    expect(authSelectCount()).toBe(1);
  });

  it('rejects an invalid conversationId before enqueueing', async () => {
    const res = await request(app)
      .post('/api/ai/query/live')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ prompt: 'ερώτηση', conversationId: 'abc' });

    expect(res.statusCode).toBe(400);
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/ai/query/live')
      .send({ prompt: 'ερώτηση' });

    expect(res.statusCode).toBe(401);
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/ai/query/live/:jobId/events', () => {
  it('streams chunk events followed by one done event and persists the answer once', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(streamingJob({ id: 'live-job-2' }));

    const { res, bodyPromise } = await openEventStream('live-job-2');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['connection']).toBe('keep-alive');
    expect(res.headers['x-accel-buffering']).toBe('no');

    await streamHub.publishChunk('live-job-2', 'Καλημέρα ');
    await streamHub.publishChunk('live-job-2', 'σας');
    await streamHub.publishDone('live-job-2', {
      result: 'Καλημέρα σας',
      sources: [SOURCE],
      confidence: 0.82
    });

    const body = await bodyPromise;
    const chunkFrames = body.match(/event: chunk/g) || [];
    expect(chunkFrames.length).toBe(2);
    expect(body).toContain('event: chunk\ndata: {"content":"Καλημέρα "}');
    expect(body).toContain('event: chunk\ndata: {"content":"σας"}');
    expect(body).toContain(
      'event: done\ndata: {"result":"Καλημέρα σας","messageId":99,"sources":[{"type":"legislation","id":7,"title":"Αστικός Κώδικας","similarity":0.8}],"confidence":0.82}'
    );

    const inserts = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('WITH inserted_assistant')
    );
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toEqual([
      5,
      'Ερώτηση;',
      'Καλημέρα σας',
      'live-job-2',
      JSON.stringify({ sources: [SOURCE], confidence: 0.82 })
    ]);
    expect(authSelectCount()).toBe(1);
  });

  it('delivers a terminal event even when the consumer attaches very late', async () => {
    const job = streamingJob({ id: 'live-job-late' });
    job.getState = jest.fn().mockResolvedValue('completed');
    job.returnvalue = 'Ολοκληρωμένη απάντηση';
    inferenceQueue.getJob.mockResolvedValueOnce(job);

    const { bodyPromise } = await openEventStream('live-job-late');
    const body = await bodyPromise;

    expect(body).toContain(
      'event: done\ndata: {"result":"Ολοκληρωμένη απάντηση","messageId":99,"sources":[{"type":"legislation","id":7,"title":"Αστικός Κώδικας","similarity":0.8}],"confidence":0.8}'
    );
    const inserts = db.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('WITH inserted_assistant')
    );
    expect(inserts.length).toBe(1);
  });

  it('replays buffered chunks published before the consumer attaches', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(streamingJob({ id: 'early-job' }));

    // Worker starts (and even finishes) before the browser opens the stream.
    await streamHub.publishChunk('early-job', 'Πρώτο ');
    await streamHub.publishChunk('early-job', 'δεύτερο');
    await streamHub.publishDone('early-job', {
      result: 'Πρώτο δεύτερο',
      sources: [],
      confidence: 0
    });

    const { bodyPromise } = await openEventStream('early-job');
    const body = await bodyPromise;

    expect(body.indexOf('"Πρώτο "')).toBeLessThan(body.indexOf('"δεύτερο"'));
    expect(body).toContain('event: done');
  });

  it('never forwards chunks published for a different job', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(streamingJob({ id: 'job-b' }));

    const { bodyPromise } = await openEventStream('job-b');
    await streamHub.publishChunk('job-a', 'Λάθος περιεχόμενο');
    await streamHub.publishChunk('job-b', 'Σωστό περιεχόμενο');
    await streamHub.publishDone('job-b', { result: 'Σωστό περιεχόμενο', sources: [], confidence: 0 });

    const body = await bodyPromise;
    expect(body).toContain('Σωστό περιεχόμενο');
    expect(body).not.toContain('Λάθος περιεχόμενο');
  });

  it('publishes an error event when the worker reports failure', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(streamingJob({ id: 'live-job-error' }));

    const { bodyPromise } = await openEventStream('live-job-error');
    await streamHub.publishError('live-job-error', 'GPU unavailable');

    const body = await bodyPromise;
    expect(body).toContain('event: error\ndata: {"error":"GPU unavailable"}');
    expect(body).not.toContain('event: done');
  });

  it('returns 404 for a job owned by another user', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(
      streamingJob({ id: 'foreign-job', data: { userId: 99 } })
    );

    const res = await request(app)
      .get('/api/ai/query/live/foreign-job/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Job not found' });
    expect(res.headers['content-type']).not.toContain('text/event-stream');
  });

  it('returns 404 for an unknown job id', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/ai/query/live/missing-job/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a non-streaming job belonging to the caller', async () => {
    inferenceQueue.getJob.mockResolvedValueOnce(
      streamingJob({ id: 'poll-job', data: { stream: false } })
    );

    const res = await request(app)
      .get('/api/ai/query/live/poll-job/events')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.statusCode).toBe(404);
  });

  it('requires authentication before looking up the job', async () => {
    const res = await request(app).get('/api/ai/query/live/live-job-2/events');

    expect(res.statusCode).toBe(401);
    expect(inferenceQueue.getJob).not.toHaveBeenCalled();
  });

  it('rejects an invalid job id', async () => {
    const res = await request(app)
      .get(`/api/ai/query/live/${'x'.repeat(129)}/events`)
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.statusCode).toBe(400);
    expect(inferenceQueue.getJob).not.toHaveBeenCalled();
  });
});
