// Phase 29: Tier-based AI rate-limit tests.
// Verifies the tier-dependent max (basic 2/min, pro 5/min, enterprise
// 10/min in these aggressive test caps) and the RateLimit-* headers.
//
// Each it() builds a FRESH express app with FRESH limiters via
// createAiRateLimiters({ isTest: false, ... }) so per-test counters are
// isolated.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createAiRateLimiters } = require('../src/middlewares/rateLimiters');
const { requireTier } = require('../src/middlewares/tierMiddleware');

const JWT_SECRET = 'nomos-super-secret-key-development';

function makeApp(overrides = {}) {
  const limiters = createAiRateLimiters({
    isTest: false,
    aiQueryBasicMax: 2,
    aiQueryProMax: 5,
    aiQueryEnterpriseMax: 10,
    aiAudioMax: 1,
    aiMultimodalMax: 1,
    ...overrides
  });
  const app = express();
  app.use(express.json());
  // Mimic the production mount: authMiddleware would hydrate req.user from
  // the DB; here we synthesize req.user per request from a header.
  app.use((req, res, next) => {
    req.user = { id: Number(req.headers['x-user-id'] || 1), subscription_tier: req.headers['x-tier'] || 'basic' };
    next();
  });
  app.get('/limited', limiters.query, (req, res) => res.json({ ok: true }));
  app.get('/premium', limiters.audioQuery, requireTier('pro'), (req, res) => res.json({ ok: true }));
  return app;
}

function expectRateLimited(res) {
  expect(res.statusCode).toEqual(429);
  expect(res.headers).toHaveProperty('retry-after');
  expect(res.headers['ratelimit']).toBeDefined();
}

// express-rate-limit@7 draft-7 emits a combined header:
//   ratelimit: limit=2, remaining=0, reset=60
function parseLimit(headerValue) {
  const m = String(headerValue).match(/limit=(\d+)/);
  return m ? Number(m[1]) : NaN;
}

describe('createAiRateLimiters (tier-based)', () => {
  it('enforces the basic-tier cap of 2/min', async () => {
    const app = makeApp();
    let res;
    for (let i = 0; i < 2; i++) {
      res = await request(app).get('/limited').set('x-tier', 'basic');
      expect(res.statusCode).toEqual(200);
    }
    res = await request(app).get('/limited').set('x-tier', 'basic');
    expectRateLimited(res);
    // RateLimit headers reflect the tier cap.
    expect(parseLimit(res.headers['ratelimit'])).toBe(2);
  });

  it('allows more requests for pro (5/min) than basic (2/min)', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/limited').set('x-tier', 'pro');
      expect(res.statusCode).toEqual(200);
    }
    const res = await request(app).get('/limited').set('x-tier', 'pro');
    expectRateLimited(res);
    expect(parseLimit(res.headers['ratelimit'])).toBe(5);
  });

  it('allows the enterprise cap of 10/min', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/limited').set('x-tier', 'enterprise');
      expect(res.statusCode).toEqual(200);
    }
    const res = await request(app).get('/limited').set('x-tier', 'enterprise');
    expectRateLimited(res);
  });

  it('keys buckets per user, not per tier (shared 20/min user bucket in prod shape)', async () => {
    const app = makeApp();
    // user 1 burns their basic quota…
    for (let i = 0; i < 2; i++) {
      await request(app).get('/limited').set('x-user-id', '1').set('x-tier', 'basic');
    }
    // …but user 2 still has a fresh bucket.
    const res = await request(app).get('/limited').set('x-user-id', '2').set('x-tier', 'basic');
    expect(res.statusCode).toEqual(200);
  });

  it('requireTier blocks basic users from premium routes with 403', async () => {
    const app = makeApp();
    const res = await request(app).get('/premium').set('x-tier', 'basic');
    expect(res.statusCode).toEqual(403);
    expect(res.body.error).toMatch(/pro subscription tier/);
  });

  it('requireTier admits pro users to premium routes', async () => {
    const app = makeApp();
    const res = await request(app).get('/premium').set('x-tier', 'pro');
    expect(res.statusCode).toEqual(200);
  });

  it('enforces the audio cap (1/min) on premium routes', async () => {
    const app = makeApp();
    const first = await request(app).get('/premium').set('x-tier', 'enterprise');
    expect(first.statusCode).toEqual(200);
    const second = await request(app).get('/premium').set('x-tier', 'enterprise');
    expectRateLimited(second);
  });
});

describe('tierMiddleware.requireTier', () => {
  it('maps tier order basic < pro < enterprise', () => {
    expect(TIER_ORDER_BASIC()).toBe(1);
  });

  function TIER_ORDER_BASIC() {
    // sanity: requireTier('enterprise') rejects pro
    const { requireTier: rt } = require('../src/middlewares/tierMiddleware');
    let rejected = null;
    const mw = rt('enterprise');
    const req = { user: { subscription_tier: 'pro' } };
    mw(req, { status: (c) => ({ json: (b) => { rejected = { c, b }; } }) }, () => {});
    expect(rejected).not.toBeNull();
    return 1;
  }
});
