// Phase 1-2: global error handler + conversationId validation + /query timeout.
//
// The global handler lives in src/index.js and is registered LAST there, after
// every route/mount. tests/app.js intentionally mounts only the routers, so
// this suite imports the REAL handler from index.js and appends it to the
// shared test app — mirroring the production ordering instead of testing a
// copy.
process.env.NODE_ENV = 'test';
// Tiny multer cap so the oversized-upload test doesn't need 25 MB of bytes.
// Removed in afterAll so other suites re-read the 25 MB default.
process.env.AI_UPLOAD_MAX_BYTES = '1024';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const inferenceQueue = require('../src/services/inferenceQueue');
const { globalErrorHandler } = require('../src/index');

const JWT_SECRET = 'nomos-super-secret-key-development';

// A route that throws on purpose, to prove unforeseen errors reach the
// handler. Registered after the real routes but before the handler, exactly
// like a production route would be.
app.get('/__test__/boom', () => {
  throw new Error('kaboom — internal details that must not leak');
});

app.use(globalErrorHandler);

afterAll(() => {
  delete process.env.AI_UPLOAD_MAX_BYTES;
});

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'basic',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken(id = 2, role = 'user') {
  return jwt.sign({ id, email: 'user@nomos.ai', role, tv: 1 }, JWT_SECRET);
}

// tests/app.js's `addInferenceJob` is the shared default: a job whose
// waitUntilFinished resolves immediately. Reinstall it after every test so a
// one-off override (e.g. the hanging job below) can never leak forward.
function restoreQueueMock() {
  inferenceQueue.addInferenceJob.mockClear();
  inferenceQueue.addInferenceJob.mockImplementation(async () => ({
    id: 'mock-job-1',
    waitUntilFinished: async () => 'Mock response'
  }));
}

describe('global error handler (src/index.js)', () => {
  afterEach(() => {
    db.query.mockReset();
    restoreQueueMock();
  });

  it('maps multer LIMIT_FILE_SIZE to a 413 JSON envelope', async () => {
    queueAuth({ id: 2, role: 'user', subscription_tier: 'enterprise' });
    const oversized = Buffer.alloc(4096, 0x41); // 4 KiB > the 1 KiB test cap

    const res = await request(app)
      .post('/api/ai/multimodal')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', oversized, 'big.pdf');

    expect(res.statusCode).toEqual(413);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual({ error: 'File too large' });
  });

  it('returns 400 JSON (not HTML) for malformed JSON bodies', async () => {
    const res = await request(app)
      .post('/api/ai/query')
      .set('Content-Type', 'application/json')
      .send('{"prompt": ');

    expect(res.statusCode).toEqual(400);
    expect(res.type).toMatch(/json/);
    expect(res.body.error).toMatch(/JSON/i);
    expect(res.text).not.toMatch(/<html/i);
  });

  it('returns 413 JSON when the JSON body exceeds the parser limit', async () => {
    // tests/app.js uses express.json() without an explicit limit (100 KiB).
    const res = await request(app)
      .post('/api/ai/query')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ prompt: 'x'.repeat(200 * 1024) }));

    expect(res.statusCode).toEqual(413);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });

  it('returns 500 JSON without leaking the error message or stack', async () => {
    const res = await request(app).get('/__test__/boom');

    expect(res.statusCode).toEqual(500);
    expect(res.type).toMatch(/json/);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(res.text).not.toMatch(/kaboom/);
    expect(res.text).not.toMatch(/at Object|node_modules/);
  });
});

describe('conversationId validation (/api/ai)', () => {
  afterEach(() => {
    db.query.mockReset();
    restoreQueueMock();
  });

  it('rejects a non-numeric conversationId with 400 on /query', async () => {
    queueAuth({ id: 2, role: 'user' });

    const res = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ prompt: 'ερώτηση', conversationId: 'abc' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/conversationId/);
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric conversationId with 400 on /query/stream', async () => {
    queueAuth({ id: 2, role: 'user' });

    const res = await request(app)
      .post('/api/ai/query/stream')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ prompt: 'ερώτηση', conversationId: 'abc' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/conversationId/);
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric conversationId on /audio-query (multipart field)', async () => {
    queueAuth({ id: 2, role: 'user', subscription_tier: 'pro' });
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake-audio')]);

    const res = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${userToken()}`)
      .field('conversationId', 'abc')
      .attach('audio', webm, 'clip.webm');

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/conversationId/);
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('normalizes a numeric-string conversationId to a number', async () => {
    queueAuth({ id: 2, role: 'user' });

    const res = await request(app)
      .post('/api/ai/query/stream')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ prompt: 'ερώτηση', conversationId: '7' });

    expect(res.statusCode).toEqual(200);
    expect(inferenceQueue.addInferenceJob).toHaveBeenCalledWith(
      'ερώτηση',
      'Formatted context',
      expect.objectContaining({ conversationId: 7 })
    );
  });

  it('rejects an over-long job id with 400 instead of using it as a Redis key', async () => {
    queueAuth({ id: 2, role: 'user' });

    const res = await request(app)
      .get(`/api/ai/query/stream/${'x'.repeat(300)}`)
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/job id/i);
  });
});

describe('/api/ai/query request timeout', () => {
  afterEach(() => {
    db.query.mockReset();
    restoreQueueMock();
    delete process.env.AI_QUERY_TIMEOUT_MS;
  });

  it('returns 504 JSON when the queue wait exceeds AI_QUERY_TIMEOUT_MS', async () => {
    process.env.AI_QUERY_TIMEOUT_MS = '50';
    queueAuth({ id: 2, role: 'user' });
    inferenceQueue.addInferenceJob.mockImplementationOnce(async () => ({
      id: 'mock-job-hang',
      waitUntilFinished: () => new Promise(() => {}) // never resolves
    }));

    const res = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ prompt: 'αργό ερώτημα' });

    expect(res.statusCode).toEqual(504);
    expect(res.type).toMatch(/json/);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it('still returns the answer when the queue finishes inside the timeout', async () => {
    process.env.AI_QUERY_TIMEOUT_MS = '5000';
    queueAuth({ id: 2, role: 'user' });

    const res = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ prompt: 'γρήγορο ερώτημα' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Mock response');
  });
});
