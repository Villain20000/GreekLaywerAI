// 1-4: Route-level quota integration through the shared tests/app.js harness.
//
// The DB seam is mocked to behave like `usage_counters`: every UPSERT returns
// an increasing count. That lets us assert the real middleware ordering
// (auth → tier gate → quota → multer → handler) without a live Postgres.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const documentService = require('../src/services/documentService');
const inferenceQueue = require('../src/services/inferenceQueue');
const transcriptionService = require('../src/services/transcriptionService');
const quotaService = require('../src/services/quotaService');

const JWT_SECRET = 'nomos-super-secret-key-development';

const QUOTA_ENV_KEYS = [
  'QUOTA_AI_BASIC',
  'QUOTA_AI_PRO',
  'QUOTA_AI_ENTERPRISE',
  'QUOTA_DOCS_BASIC',
  'QUOTA_DOCS_PRO',
  'QUOTA_DOCS_ENTERPRISE'
];

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake-audio')]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake pdf body')]);

function tokenFor(id, email = 'user@nomos.ai') {
  return jwt.sign({ id, email, role: 'user', tv: 1 }, JWT_SECRET);
}

function userRow(overrides = {}) {
  return {
    id: overrides.id ?? 2,
    email: overrides.email ?? 'user@nomos.ai',
    role: overrides.role ?? 'user',
    subscription_tier: overrides.subscription_tier ?? 'basic',
    created_at: new Date('2024-01-01T00:00:00Z'),
    token_version: 1,
    verified_at: new Date('2024-01-01T00:00:00Z')
  };
}

/**
 * Install a DB mock that serves authMiddleware and models the quota table.
 * Returns counters so tests can assert whether the quota was consulted.
 *
 * `aiCount` is the current value of the daily AI counter row (what the
 * read-only usage endpoint reports); `docCount` is the number of uploaded
 * documents (what the document cap counts).
 */
function installDb({ user, docCount = 0, aiCount = 0 } = {}) {
  const counters = { ai: 0, documentCountQueries: 0, usageReads: 0 };

  db.query.mockImplementation(async (sql) => {
    if (/FROM users WHERE id = \$1/.test(sql)) {
      return { rows: [user] };
    }
    if (/INSERT INTO usage_counters/.test(sql)) {
      counters.ai += 1;
      return { rows: [{ count: counters.ai }] };
    }
    if (/SELECT count FROM usage_counters/.test(sql)) {
      counters.usageReads += 1;
      return { rows: aiCount ? [{ count: aiCount }] : [] };
    }
    if (/COUNT\(\*\)::int AS count FROM legal_documents/.test(sql)) {
      counters.documentCountQueries += 1;
      return { rows: [{ count: docCount }] };
    }
    return { rows: [] };
  });

  return counters;
}

function clearQuotaEnv() {
  for (const key of QUOTA_ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  db.query.mockReset();
  clearQuotaEnv();
  documentService.processAndStoreDocument.mockClear();
  documentService.extractMetadata.mockClear();
  inferenceQueue.addInferenceJob.mockClear();
  transcriptionService.transcribe.mockClear();
});

afterEach(() => {
  db.query.mockReset();
  clearQuotaEnv();
});

describe('POST /api/ai/* — daily AI quota (1-4)', () => {
  it('allows the first basic query and 429s the second', async () => {
    process.env.QUOTA_AI_BASIC = '1';
    const counters = installDb({ user: userRow() });
    const auth = tokenFor(2);

    const first = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${auth}`)
      .send({ prompt: 'Τι λέει το άρθρο 57 ΑΚ;' });
    expect(first.statusCode).toEqual(200);
    expect(first.body).toHaveProperty('response', 'Mock response');

    const second = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${auth}`)
      .send({ prompt: 'Δεύτερη ερώτηση' });
    expect(second.statusCode).toEqual(429);
    expect(second.body).toMatchObject({
      error: 'Daily AI query limit reached for your plan',
      limit: 1,
      used: 2,
      tier: 'basic'
    });
    expect(new Date(second.body.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(second.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    expect(inferenceQueue.addInferenceJob).toHaveBeenCalledTimes(1);
    expect(counters.ai).toBe(2);
  });

  it('shares one counter between /query and /query/stream', async () => {
    process.env.QUOTA_AI_BASIC = '1';
    installDb({ user: userRow() });
    const auth = tokenFor(2);

    const stream = await request(app)
      .post('/api/ai/query/stream')
      .set('Authorization', `Bearer ${auth}`)
      .send({ prompt: 'Ροή απάντησης' });
    expect(stream.statusCode).toEqual(200);
    expect(stream.body).toHaveProperty('jobId');

    const query = await request(app)
      .post('/api/ai/query')
      .set('Authorization', `Bearer ${auth}`)
      .send({ prompt: 'Μετά τη ροή' });
    expect(query.statusCode).toEqual(429);
    expect(inferenceQueue.addInferenceJob).toHaveBeenCalledTimes(1);
  });

  it('applies the quota to /audio-query after the pro tier gate', async () => {
    process.env.QUOTA_AI_PRO = '1';
    installDb({ user: userRow({ subscription_tier: 'pro' }) });
    const auth = tokenFor(2);

    const first = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${auth}`)
      .attach('audio', WEBM, 'clip.webm');
    expect(first.statusCode).toEqual(200);

    const second = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${auth}`)
      .attach('audio', WEBM, 'clip.webm');
    expect(second.statusCode).toEqual(429);
    expect(second.body).toMatchObject({ limit: 1, used: 2, tier: 'pro' });
    expect(transcriptionService.transcribe).toHaveBeenCalledTimes(1);
  });

  it('applies the quota to /multimodal before multer buffers the file', async () => {
    process.env.QUOTA_AI_ENTERPRISE = '1';
    installDb({ user: userRow({ subscription_tier: 'enterprise' }) });
    const auth = tokenFor(2);

    const first = await request(app)
      .post('/api/ai/multimodal')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', PDF, 'contract.pdf');
    expect(first.statusCode).toEqual(200);

    // The second request is rejected by the quota middleware before bytes are
    // parsed; appending a deliberately garbage file proves it never reached
    // the magic-byte validator/multer pipeline.
    const second = await request(app)
      .post('/api/ai/multimodal')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', Buffer.from([0x00, 0x01, 0x02]), 'evil.bin');
    expect(second.statusCode).toEqual(429);
    expect(documentService.extractMetadata).toHaveBeenCalledTimes(1);
  });

  it('lets admins bypass the AI quota entirely', async () => {
    process.env.QUOTA_AI_BASIC = '1';
    const counters = installDb({ user: userRow({ id: 99, role: 'admin' }) });
    const auth = tokenFor(99, 'admin@nomos.ai');

    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .post('/api/ai/query')
        .set('Authorization', `Bearer ${auth}`)
        .send({ prompt: `admin ${i}` });
      expect(res.statusCode).toEqual(200);
    }
    expect(counters.ai).toBe(0);
  });
});

describe('POST /api/documents — document cap (1-4)', () => {
  it('returns 403 before multer when the basic cap (10) is reached', async () => {
    process.env.QUOTA_DOCS_BASIC = '10';
    const counters = installDb({ user: userRow(), docCount: 10 });
    const auth = tokenFor(2);

    // Garbage bytes would be rejected by validateUploadedFile (400) if the
    // request reached multer — 403 here proves the cap runs first.
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', Buffer.from([0x00, 0x01, 0x02, 0x03]), 'evil.bin');

    expect(res.statusCode).toEqual(403);
    expect(res.body).toEqual({
      error: 'Document limit reached for your plan',
      limit: 10,
      used: 10,
      tier: 'basic'
    });
    expect(documentService.processAndStoreDocument).not.toHaveBeenCalled();
    expect(counters.documentCountQueries).toBe(1);
  });

  it('allows an upload below the cap', async () => {
    process.env.QUOTA_DOCS_BASIC = '10';
    installDb({ user: userRow(), docCount: 9 });
    const auth = tokenFor(2);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', PDF, 'contract.pdf');

    expect(res.statusCode).toEqual(201);
    expect(documentService.processAndStoreDocument).toHaveBeenCalledTimes(1);
  });

  it('enforces the pro cap (50)', async () => {
    process.env.QUOTA_DOCS_PRO = '50';
    installDb({ user: userRow({ subscription_tier: 'pro' }), docCount: 50 });
    const auth = tokenFor(2);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', PDF, 'contract.pdf');

    expect(res.statusCode).toEqual(403);
    expect(res.body).toMatchObject({ limit: 50, used: 50, tier: 'pro' });
  });

  it('never blocks an enterprise (unlimited) account and skips the COUNT', async () => {
    process.env.QUOTA_DOCS_ENTERPRISE = 'unlimited';
    const counters = installDb({ user: userRow({ subscription_tier: 'enterprise' }), docCount: 9999 });
    const auth = tokenFor(2);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', PDF, 'contract.pdf');

    expect(res.statusCode).toEqual(201);
    expect(counters.documentCountQueries).toBe(0);
  });

  it('lets admins bypass the document cap', async () => {
    process.env.QUOTA_DOCS_BASIC = '1';
    const counters = installDb({ user: userRow({ id: 99, role: 'admin' }), docCount: 9999 });
    const auth = tokenFor(99, 'admin@nomos.ai');

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${auth}`)
      .attach('file', PDF, 'contract.pdf');

    expect(res.statusCode).toEqual(201);
    expect(counters.documentCountQueries).toBe(0);
  });
});

describe('GET /api/subscriptions/usage — read-only quota usage (1-4)', () => {
  it('401s without a token', async () => {
    const res = await request(app).get('/api/subscriptions/usage');
    expect(res.statusCode).toEqual(401);
  });

  it('reports the AI usage and the document count against the tier limits', async () => {
    // Mirror the production defaults (DEFAULT_AI_LIMITS.basic = 20,
    // DEFAULT_DOCUMENT_LIMITS.basic = 10) so the assertion is about the
    // tier→limit mapping, not about the test ceiling.
    process.env.QUOTA_AI_BASIC = '20';
    process.env.QUOTA_DOCS_BASIC = '10';
    installDb({ user: userRow(), aiCount: 3, docCount: 2 });
    const auth = tokenFor(2);

    const res = await request(app)
      .get('/api/subscriptions/usage')
      .set('Authorization', `Bearer ${auth}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.tier).toBe('basic');
    expect(res.body.ai.used).toBe(3);
    expect(res.body.ai.limit).toBe(20);
    // resetAt is the next UTC midnight — always in the future.
    expect(new Date(res.body.ai.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.ai.resetAt.endsWith('T00:00:00.000Z')).toBe(true);
    expect(res.body.documents.used).toBe(2);
    expect(res.body.documents.limit).toBe(10);
  });

  it('derives both limits from the shared tier→limit helpers (no duplicated mapping)', async () => {
    const aiLimitSpy = jest.spyOn(quotaService, 'getAiDailyLimit').mockReturnValue(7);
    const docLimitSpy = jest.spyOn(quotaService, 'getDocumentLimit').mockReturnValue(3);
    try {
      installDb({ user: userRow(), aiCount: 1, docCount: 1 });
      const auth = tokenFor(2);

      const res = await request(app)
        .get('/api/subscriptions/usage')
        .set('Authorization', `Bearer ${auth}`);

      expect(res.statusCode).toEqual(200);
      // The route asks quotaService for the limits — the same helpers
      // quotaMiddleware uses to enforce them — instead of hard-coding a
      // second copy of the tier table.
      expect(aiLimitSpy).toHaveBeenCalledWith('basic');
      expect(docLimitSpy).toHaveBeenCalledWith('basic');
      expect(res.body.ai.limit).toBe(7);
      expect(res.body.documents.limit).toBe(3);
    } finally {
      aiLimitSpy.mockRestore();
      docLimitSpy.mockRestore();
    }
  });

  it('passes the tier limit into getUsage exactly as its docstring describes', async () => {
    process.env.QUOTA_AI_BASIC = '20';
    const usageSpy = jest.spyOn(quotaService, 'getUsage');
    try {
      installDb({ user: userRow(), aiCount: 5 });
      const auth = tokenFor(2);

      const res = await request(app)
        .get('/api/subscriptions/usage')
        .set('Authorization', `Bearer ${auth}`);

      expect(res.statusCode).toEqual(200);
      expect(usageSpy).toHaveBeenCalledWith(2, 'ai', { limit: 20 });
      expect(res.body.ai.used).toBe(5);
      expect(res.body.ai.limit).toBe(20);
    } finally {
      usageSpy.mockRestore();
    }
  });

  it('is read-only — it never consumes quota', async () => {
    const counters = installDb({ user: userRow(), aiCount: 4, docCount: 1 });
    const auth = tokenFor(2);

    const res = await request(app)
      .get('/api/subscriptions/usage')
      .set('Authorization', `Bearer ${auth}`);

    expect(res.statusCode).toEqual(200);
    // No UPSERT fired: the daily counter was READ, never incremented.
    expect(counters.ai).toBe(0);
    expect(counters.usageReads).toBe(1);
  });

  it('fails open with zeros when the usage queries blow up (DB blip)', async () => {
    process.env.QUOTA_AI_BASIC = '20';
    process.env.QUOTA_DOCS_BASIC = '10';
    // authMiddleware still resolves; every quota query throws.
    db.query.mockImplementation(async (sql) => {
      if (/FROM users WHERE id = \$1/.test(sql)) {
        return { rows: [userRow()] };
      }
      throw new Error('pool exhausted');
    });
    const auth = tokenFor(2);

    const res = await request(app)
      .get('/api/subscriptions/usage')
      .set('Authorization', `Bearer ${auth}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.ai.used).toBe(0);
    expect(res.body.ai.limit).toBe(20);
    expect(res.body.documents.used).toBe(0);
    expect(res.body.documents.limit).toBe(10);
  });

  it('reports a null document limit for the unlimited enterprise tier', async () => {
    process.env.QUOTA_AI_ENTERPRISE = '120';
    process.env.QUOTA_DOCS_ENTERPRISE = 'unlimited';
    installDb({
      user: userRow({ subscription_tier: 'enterprise' }),
      aiCount: 11,
      docCount: 123
    });
    const auth = tokenFor(2);

    const res = await request(app)
      .get('/api/subscriptions/usage')
      .set('Authorization', `Bearer ${auth}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.tier).toBe('enterprise');
    expect(res.body.ai.limit).toBe(120);
    expect(res.body.documents.used).toBe(123);
    expect(res.body.documents.limit).toBeNull();
  });

  it('reports unlimited (null) limits for admins, matching the quota bypass', async () => {
    // Admins are never quota-limited (quotaMiddleware.isAdmin /
    // tierMiddleware). The usage endpoint must not advertise a cap the
    // enforcement path would never apply.
    installDb({
      user: userRow({ id: 99, role: 'admin' }),
      aiCount: 4,
      docCount: 9
    });
    const auth = tokenFor(99, 'admin@nomos.ai');

    const res = await request(app)
      .get('/api/subscriptions/usage')
      .set('Authorization', `Bearer ${auth}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.ai.limit).toBeNull();
    expect(res.body.documents.limit).toBeNull();
    // The counters are still reported.
    expect(res.body.ai.used).toBe(4);
    expect(res.body.documents.used).toBe(9);
  });
});
