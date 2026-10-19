// 1-3: rate-limit coverage outside /api/ai.
//
// Two layers of coverage:
//
// 1. Enforcement: each limiter is constructed via createApiRateLimiters()
//    with aggressive caps (isTest:false + explicit max overrides) and mounted
//    on a fresh express app with a synthesized req.user — the same approach
//    as aiRateLimit.test.js. This pins the 429 behavior, RateLimit headers,
//    and per-user bucketing.
// 2. Wiring: requests through the real routers (tests/app.js mount set) must
//    carry RateLimit headers, proving each route actually mounts its limiter
//    (in tests those instances use the 1000-request TEST_CEILING, so they
//    never block).
//
// The Stripe webhook is intentionally NOT rate-limited (Stripe retries must
// not receive generic 429s); its idempotency is covered by webhook.test.js.

process.env.NODE_ENV = 'test';
// Pin mock Stripe mode before tests/app.js loads stripeService, so
// /api/subscriptions/cancel takes the no-Stripe-call branch.
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const app = require('./app');
const db = require('../src/config/db');
const {
  createApiRateLimiters,
  createRateLimiters
} = require('../src/middlewares/rateLimiters');

const JWT_SECRET = 'nomos-super-secret-key-development';

function expectRateLimited(res) {
  expect(res.statusCode).toEqual(429);
  expect(res.body.error).toMatch(/too many/i);
  expect(res.headers).toHaveProperty('retry-after');
  expect(res.headers['ratelimit']).toBeDefined();
}

// express-rate-limit@7 draft-7 emits a combined header:
//   ratelimit: limit=2, remaining=0, reset=60
function parseLimit(headerValue) {
  const m = String(headerValue).match(/limit=(\d+)/);
  return m ? Number(m[1]) : NaN;
}

/**
 * Fresh app + fresh limiter instances (isolated in-memory counters) with a
 * req.user synthesized from x-user-id, mimicking the authMiddleware mount in
 * index.js/tests/app.js.
 */
function makeApp(overrides = {}) {
  const limiters = createApiRateLimiters({ isTest: false, ...overrides });
  const upload = multer({ storage: multer.memoryStorage() });

  const api = express();
  api.use(express.json());
  api.use((req, res, next) => {
    req.user = { id: Number(req.headers['x-user-id'] || 1) };
    next();
  });

  api.post('/api/documents', limiters.documentUpload, upload.single('file'), (req, res) => {
    res.status(201).json({ ok: true, gotFile: Boolean(req.file) });
  });
  api.post('/api/documents/search', limiters.documentSearch, (req, res) => {
    res.json({ ok: true });
  });
  api.get('/api/conversations', limiters.conversationList, (req, res) => {
    res.json({ ok: true });
  });
  api.post('/api/conversations', limiters.conversationCreate, (req, res) => {
    res.status(201).json({ ok: true });
  });
  api.get('/api/subscriptions', limiters.subscriptionRead, (req, res) => {
    res.json({ ok: true });
  });
  api.post('/api/subscriptions/cancel', limiters.subscriptionCancel, (req, res) => {
    res.json({ ok: true });
  });
  api.get('/api/gdpr/export', limiters.gdprExport, (req, res) => {
    res.json({ ok: true });
  });
  api.delete('/api/gdpr/account', limiters.gdprDelete, (req, res) => {
    res.json({ ok: true });
  });
  api.post('/api/billing/create-checkout-session', limiters.billingCheckout, (req, res) => {
    res.json({ ok: true });
  });
  api.post('/api/billing/mock-complete', limiters.billingMockComplete, (req, res) => {
    res.json({ ok: true });
  });
  return api;
}

function uploadDocument(api, userId = '1') {
  return request(api)
    .post('/api/documents')
    .set('x-user-id', userId)
    .attach('file', Buffer.from('legal document body for testing'), 'doc.txt');
}

describe('createApiRateLimiters (enforcement)', () => {
  it('enforces the documents upload cap (2/min) and stops before multer/handler', async () => {
    const api = makeApp({ documentUploadMax: 2 });

    for (let i = 0; i < 2; i++) {
      const res = await uploadDocument(api);
      expect(res.statusCode).toEqual(201);
      expect(res.body).toEqual({ ok: true, gotFile: true });
    }

    const blocked = await uploadDocument(api);
    expectRateLimited(blocked);
    expect(parseLimit(blocked.headers['ratelimit'])).toBe(2);
  });

  it('keys the documents upload bucket per user, not globally', async () => {
    const api = makeApp({ documentUploadMax: 2 });

    await uploadDocument(api, '1');
    await uploadDocument(api, '1');
    expectRateLimited(await uploadDocument(api, '1'));

    // A different authenticated user gets a fresh bucket.
    const other = await uploadDocument(api, '2');
    expect(other.statusCode).toEqual(201);
  });

  it('enforces the subscriptions cancel cap (2/min)', async () => {
    const api = makeApp({ subscriptionCancelMax: 2 });

    for (let i = 0; i < 2; i++) {
      const res = await request(api).post('/api/subscriptions/cancel').set('x-user-id', '1');
      expect(res.statusCode).toEqual(200);
    }
    expectRateLimited(
      await request(api).post('/api/subscriptions/cancel').set('x-user-id', '1')
    );
  });

  it('enforces the GDPR export cap (1/min in this test) and the delete cap', async () => {
    const api = makeApp({ gdprExportMax: 1, gdprDeleteMax: 1 });

    expect((await request(api).get('/api/gdpr/export').set('x-user-id', '1')).statusCode).toBe(200);
    expectRateLimited(await request(api).get('/api/gdpr/export').set('x-user-id', '1'));

    expect((await request(api).delete('/api/gdpr/account').set('x-user-id', '1')).statusCode).toBe(200);
    expectRateLimited(await request(api).delete('/api/gdpr/account').set('x-user-id', '1'));
  });

  it('enforces the billing checkout + mock-complete caps (1/min in this test)', async () => {
    const api = makeApp({ billingCheckoutMax: 1, billingMockCompleteMax: 1 });

    expect(
      (await request(api).post('/api/billing/create-checkout-session').set('x-user-id', '1')).statusCode
    ).toBe(200);
    expectRateLimited(
      await request(api).post('/api/billing/create-checkout-session').set('x-user-id', '1')
    );

    expect(
      (await request(api).post('/api/billing/mock-complete').set('x-user-id', '1')).statusCode
    ).toBe(200);
    expectRateLimited(
      await request(api).post('/api/billing/mock-complete').set('x-user-id', '1')
    );
  });

  it('enforces the conversations list/create + documents search caps', async () => {
    const api = makeApp({
      conversationListMax: 1,
      conversationCreateMax: 1,
      documentSearchMax: 1
    });

    expect((await request(api).get('/api/conversations').set('x-user-id', '1')).statusCode).toBe(200);
    expectRateLimited(await request(api).get('/api/conversations').set('x-user-id', '1'));

    expect((await request(api).post('/api/conversations').set('x-user-id', '1')).statusCode).toBe(201);
    expectRateLimited(await request(api).post('/api/conversations').set('x-user-id', '1'));

    expect(
      (await request(api).post('/api/documents/search').set('x-user-id', '1').send({ query: 'x' }))
        .statusCode
    ).toBe(200);
    expectRateLimited(
      await request(api).post('/api/documents/search').set('x-user-id', '1').send({ query: 'x' })
    );
  });

  it('enforces the lenient /api/auth/me cap per user (2/min in this test)', async () => {
    // The /me limiter lives in the auth factory (per-user, after
    // authMiddleware) — mount it the same way auth.js does.
    const limiters = createRateLimiters({ isTest: false, meMax: 2 });
    const auth = express();
    auth.use((req, res, next) => {
      req.user = { id: Number(req.headers['x-user-id'] || 1) };
      next();
    });
    auth.get('/api/auth/me', limiters.me, (req, res) => res.json({ ok: true }));

    for (let i = 0; i < 2; i++) {
      expect((await request(auth).get('/api/auth/me').set('x-user-id', '1')).statusCode).toBe(200);
    }
    expectRateLimited(await request(auth).get('/api/auth/me').set('x-user-id', '1'));
    expect((await request(auth).get('/api/auth/me').set('x-user-id', '2')).statusCode).toBe(200);
  });
});

describe('limiter wiring on the real routers', () => {
  function queueAuth(overrides = {}) {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: overrides.id ?? 2,
        email: overrides.email ?? 'user@nomos.ai',
        role: overrides.role ?? 'user',
        subscription_tier: overrides.subscription_tier ?? 'basic',
        created_at: new Date('2024-01-01T00:00:00Z'),
        token_version: overrides.token_version ?? 1,
        verified_at: new Date('2026-01-01T00:00:00Z')
      }]
    });
    db.query.mockResolvedValue({ rows: [] });
  }

  function userToken(id = 2) {
    return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
  }

  afterEach(() => {
    db.query.mockReset();
  });

  it('mounts a limiter on POST /api/documents (upload)', async () => {
    queueAuth();

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', Buffer.from('legal document body for testing'), 'doc.txt');

    expect(res.statusCode).toEqual(201);
    expect(res.headers['ratelimit']).toBeDefined();
  });

  it('mounts a limiter on GET /api/conversations and POST /api/documents/search', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] }); // conversations list

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(list.statusCode).toEqual(200);
    expect(list.headers['ratelimit']).toBeDefined();

    queueAuth();
    const search = await request(app)
      .post('/api/documents/search')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ query: 'ενοίκιο' });
    expect(search.statusCode).toEqual(200);
    expect(search.headers['ratelimit']).toBeDefined();
  });

  it('mounts limiters on GET /api/subscriptions and POST /api/subscriptions/cancel', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] }); // no subscription row
    const read = await request(app)
      .get('/api/subscriptions')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(read.statusCode).toEqual(200);
    expect(read.headers['ratelimit']).toBeDefined();

    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, status: 'active', stripe_subscription_id: null }]
    });
    const cancel = await request(app)
      .post('/api/subscriptions/cancel')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(cancel.statusCode).toEqual(200);
    expect(cancel.headers['ratelimit']).toBeDefined();
  });

  it('mounts the auth /me limiter', async () => {
    queueAuth();

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.headers['ratelimit']).toBeDefined();
  });
});
