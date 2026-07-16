// Phase 21: Rate-limit integration tests.
// Pins NODE_ENV='test' (line 1, before source requires) so the in-memory
// store is picked up by rateLimiters.js when no REDIS_URL is present.
//
// Each it() builds a FRESH express app with FRESH limiters via
// createRateLimiters({ isTest: false, ... }). The factory's in-memory store
// is constructed per call, so per-test counters are isolated — no `jest.useFakeTimers`
// or `timeAdvance` needed. Counter state resets on every beforeEach.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');
const { createRateLimiters } = require('../src/middlewares/rateLimiters');

jest.mock('../src/config/db', () => ({
  query: jest.fn()
}));

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';

function makeToken(id, email = 'user@nomos.ai', role = 'user') {
  // Phase 22: embed `tv: 1` so authMiddleware's strict-equality check
  // (`dbUser.token_version === decoded.tv`) accepts the test JWT. Without
  // this the strict check fails (1 !== undefined) and the route 401s before
  // the per-account rate limiter ever runs.
  return jwt.sign({ id, email, role, tv: 1 }, JWT_SECRET);
}

function makeApp(overrides = {}) {
  const limiters = createRateLimiters({
    isTest: false,            // force production caps, but in-memory store (no Redis)
    registerMax: 3,
    loginMax: 3,
    cpIpMax: 100,             // generous; not the focus of these tests
    cpAccountMax: 2,
    cpAccountDailyMax: 50,
    ...overrides
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

function expectRateLimited(res) {
  expect(res.statusCode).toEqual(429);
  expect(res.body).toHaveProperty('error');
  expect(res.body.error).toMatch(/too many/i);
  // express-rate-limit@7 emits IETF draft-7 RateLimit headers.
  expect(res.headers).toHaveProperty('retry-after');
  expect(res.headers['ratelimit']).toBeDefined();
}

/**
 * Phase 22: install a per-id db.query mock for change-password tests so that
 * `authMiddleware`'s row genuinely has id == decoded.id (instead of a static
 * row). Without this, the per-account counter key falls back to id=2 for
 * every user, breaking the isolation assertion.
 */
function setupChangePasswordMock(currentHash) {
  db.query.mockImplementation(async (_sql, params) => {
    const id = params && params[0] !== undefined ? params[0] : 2;
    return {
      rows: [{
        id,
        email: `${id}@nomos.ai`,
        role: 'user',
        subscription_tier: 'basic',
        password_hash: currentHash, // satisfies change-password lookup
        created_at: new Date('2024-01-01T00:00:00Z'),
        token_version: 1             // satisfies authMiddleware strict equality
      }]
    };
  });
}

describe('Rate limiting on /api/auth/*', () => {
  // resetAllMocks (not clearAllMocks) so the mockResolvedValue / once-queue
  // doesn't leak across tests.
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('register (per-IP)', () => {
    it('returns 200 for the first {max} requests then 429 with Retry-After', async () => {
      const app = makeApp({ registerMax: 3 });

      // Force every attempt to short-circuit with "user exists" (cheap path;
      // avoids running bcrypt 3 times). The limiter still increments because
      // it sits BEFORE the handler.
      db.query.mockResolvedValue({ rows: [{ id: 1 }] });

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: `u${i}@nomos.ai`, password: 'password123' });
        expect(res.statusCode).toEqual(400); // 'User already exists'
      }

      const blocked = await request(app)
        .post('/api/auth/register')
        .send({ email: 'blocked@nomos.ai', password: 'password123' });
      expectRateLimited(blocked);
    });

    it('counter resets on a fresh limiter instance (per-test isolation)', async () => {
      const appA = makeApp({ registerMax: 1 });
      db.query.mockResolvedValue({ rows: [{ id: 1 }] });

      expect((await request(appA).post('/api/auth/register').send({ email: 'a@nomos.ai', password: 'password123' })).statusCode).toEqual(400);
      expectRateLimited(await request(appA).post('/api/auth/register').send({ email: 'a@nomos.ai', password: 'password123' }));

      const appB = makeApp({ registerMax: 1 });
      expect((await request(appB).post('/api/auth/register').send({ email: 'b@nomos.ai', password: 'password123' })).statusCode).toEqual(400);
    });
  });

  describe('login (per-IP)', () => {
    it('returns 429 after loginMax requests regardless of credentials', async () => {
      const app = makeApp({ loginMax: 3 });

      // "No such user" path — bcrypt.compare is short-circuited by the empty
      // rows check, so no crypto cost.
      db.query.mockResolvedValue({ rows: [] });

      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'noone@nomos.ai', password: 'whatever' });
        expect(res.statusCode).toEqual(400); // 'Invalid credentials'
      }

      expectRateLimited(
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'noone@nomos.ai', password: 'whatever' })
      );
    });
  });

  describe('change-password (per-IP pre-auth + per-account)', () => {
    // Low-cost hash so bcrypt.compare runs in ~5ms per call.
    const currentHash = bcrypt.hashSync('oldPassword123', 4);

    it('returns 429 from per-account limiter after cpAccountMax valid attempts', async () => {
      const app = makeApp({ cpAccountMax: 2 });
      const tok = makeToken(2);

      // Per-id mock so authMiddleware's row matches the JWT's id.
      setupChangePasswordMock(currentHash);

      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .post('/api/auth/change-password')
          .set('Authorization', `Bearer ${tok}`)
          .send({ currentPassword: 'wrong-password', newPassword: `newPass456${i}` });
        expect(res.statusCode).toEqual(400); // 'Password change failed'
      }

      const blocked = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tok}`)
        .send({ currentPassword: 'wrong-password', newPassword: 'newPass789' });
      expectRateLimited(blocked);
    });

    it('isolates the per-account counter per user id', async () => {
      const app = makeApp({ cpAccountMax: 2 });
      const tok2 = makeToken(2);
      const tok99 = makeToken(99);

      setupChangePasswordMock(currentHash);

      // Exhaust limit for user id=2.
      for (let i = 0; i < 2; i++) {
        await request(app)
          .post('/api/auth/change-password')
          .set('Authorization', `Bearer ${tok2}`)
          .send({ currentPassword: 'wrong-password', newPassword: `newX${i}` });
      }
      expectRateLimited(
        await request(app)
          .post('/api/auth/change-password')
          .set('Authorization', `Bearer ${tok2}`)
          .send({ currentPassword: 'wrong-password', newPassword: 'newX999' })
      );

      // User id=99 starts with a clean counter; first attempt should NOT be 429.
      const user99 = await request(app)
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${tok99}`)
        .send({ currentPassword: 'wrong-password', newPassword: 'newY' });
      expect(user99.statusCode).not.toEqual(429);
    });

    it('returns 429 from pre-auth per-IP limiter when many forged-token requests hit', async () => {
      // Override: tiny per-IP, generous per-account, so we isolate the
      // pre-auth limiter behavior.
      const app = makeApp({ cpIpMax: 3, cpAccountMax: 100, cpAccountDailyMax: 100 });

      // No Authorization header → authMiddleware would 401 each, but the
      // per-IP limiter sits BEFORE authMiddleware so it still increments.
      const statuses = [];
      for (let i = 0; i < 4; i++) {
        const res = await request(app)
          .post('/api/auth/change-password')
          .send({ currentPassword: 'whatever', newPassword: 'newPassword123' });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]); // authMiddleware rejects
      expect(statuses[3]).toEqual(429);                     // pre-auth trips
    });
  });
});
