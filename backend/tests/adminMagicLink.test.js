// Phase 25: admin magic-link redeem tests.
//
// `process.env.NODE_ENV = 'test'` (set in tests/app.js) makes
// createRateLimiters() apply the 1000-iteration test ceiling, so the
// 20/min per-IP brute-force guard doesn't trip during a single jest run.
//
// Each `it()` builds a FRESH express app + FRESH limiters via `makeApp()`
// so per-test counter state is isolated. The DB mock is reset in
// beforeEach via `db.query.mockReset()`.
//
// These tests don't depend on tests/app.js's harness because admin magic
// link doesn't use db.connect() (transactions) and so the test file is
// a smaller, more focused mock surface.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';

function makeApp(overrides = {}) {
  // Lazy require: avoid pulling rateLimiters at test-file top so the
  // process.env.NODE_ENV='test' gait set in tests/app.js has a chance
  // to take effect for whichever harness includes this file.
  const { createRateLimiters } = require('../src/middlewares/rateLimiters');
  const limiters = createRateLimiters({
    isTest: false,
    // Generous caps; these tests are about route logic, not the limiter.
    registerMax: 100,
    loginMax: 100,
    cpIpMax: 100,
    cpAccountMax: 100,
    cpAccountDailyMax: 100,
    forgotIpMaxMin: 100,
    forgotIpMaxHour: 100,
    forgotEmailMax: 100,
    resetIpMax: 100,
    verifyIpMax: 100,
    resendIpMax: 100,
    resendEmailMax: 100,
    ...overrides
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

describe('Phase 25: admin magic-link redeem', () => {
  const ADMIN_ID = 7;
  const ADMIN_EMAIL = 'admin@nomos.ai';

  beforeEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
  });

  describe('happy path', () => {
    it('returns 200 + session JWT whose tv is bumped on a valid admin-magic token', async () => {
      const app = makeApp();
      // Sign a JWT matching the CLI's payload shape.
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );

      // 1st query: SELECT users WHERE id = $1 (admin lookup).
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise'
        }],
        rowCount: 1
      });
      // 2nd query: UPDATE users SET token_version = token_version + 1 ...
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 3
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.role).toBe('admin');
      expect(res.body.user.token_version).toBe(3);

      // Fresh JWT must be signed with the bumped tv so authMiddleware
      // accepts it on the next request (Phase 22 strict-equality check).
      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.tv).toBe(3);
      expect(decoded.id).toBe(ADMIN_ID);
      expect(decoded.role).toBe('admin');

      // UPDATE users must atomically bump token_version.
      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      expect(updateCall[1][0]).toBe(ADMIN_ID);
    });
  });

  describe('production gate', () => {
    let originalEnv;

    beforeEach(() => {
      // Save the original env so per-test mutation doesn't leak across suites.
      originalEnv = {
        NODE_ENV: process.env.NODE_ENV,
        ADMIN_MAGIC_LINK_ENABLED: process.env.ADMIN_MAGIC_LINK_ENABLED
      };
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
      if (originalEnv.ADMIN_MAGIC_LINK_ENABLED === undefined) {
        delete process.env.ADMIN_MAGIC_LINK_ENABLED;
      } else {
        process.env.ADMIN_MAGIC_LINK_ENABLED = originalEnv.ADMIN_MAGIC_LINK_ENABLED;
      }
    });

    it('returns 404 when NODE_ENV=production and ADMIN_MAGIC_LINK_ENABLED is unset', async () => {
      const app = makeApp();
      process.env.NODE_ENV = 'production';
      delete process.env.ADMIN_MAGIC_LINK_ENABLED;

      // Even with a perfectly-valid admin_magic token the gate rejects.
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(404);
      expect(res.body.error).toBe('Not found');
      // Gate short-circuits before DB lookup.
      expect(db.query).not.toHaveBeenCalled();
    });

    it('works in production when ADMIN_MAGIC_LINK_ENABLED=true', async () => {
      const app = makeApp();
      process.env.NODE_ENV = 'production';
      process.env.ADMIN_MAGIC_LINK_ENABLED = 'true';

      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise'
        }],
        rowCount: 1
      });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 4
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('defensive rejections', () => {
    it('returns 403 when the user is no longer admin (role re-read defense)', async () => {
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'user', subscription_tier: 'basic'
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toBe('Admin role required');
      // No UPDATE issued \u2014 the role check short-circuits before tv bump.
      expect(db.query).toHaveBeenCalledTimes(1);
    });

    it('returns 400 with unified copy when the kind claim is missing', async () => {
      const app = makeApp();
      // Sign with NO kind claim \u2014 simulates a regular session JWT being
      // mistakenly passed to this route.
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, tv: 1 },
        JWT_SECRET,
        { expiresIn: '5m' }
      );

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 400 with unified copy when the kind claim is wrong', async () => {
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'session' }, // valid JWT, wrong kind
        JWT_SECRET,
        { expiresIn: '5m' }
      );

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 400 with unified copy when token is expired (TTL defense)', async () => {
      const app = makeApp();
      const expired = -1; // past
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: expired }
      );

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 400 with unified copy when JWT signature is invalid', async () => {
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        'wrong-secret',
        { expiresIn: '5m' }
      );

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 400 when token field is missing', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({});
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 400 when db.user lookup yields zero rows mid-flight', async () => {
      const app = makeApp();
      const token = jwt.sign(
        { id: 999999, email: 'ghost@nomos.ai', kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired magic link');
      // No UPDATE attempted.
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('documented trade-offs', () => {
    it('redeems successfully on each replay within TTL — the documented no-dedupe behavior', async () => {
      // Without a DB-backed jti dedupe table, the same bearer can be
      // redeemed repeatedly within its TTL window. Each redemption mints
      // a fresh session JWT and bumps `token_version` once more. This
      // test pins that behavior so a future contributor doesn't
      // accidentally "fix" the trade-off by adding dedupe and surprise
      // operators who relied on the unlimited-replay shortcut.
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );

      // First redeem: SELECT(user), UPDATE(tv: 2 -> 3)
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 2
        }],
        rowCount: 1
      });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 3
        }],
        rowCount: 1
      });

      const firstRes = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });
      expect(firstRes.statusCode).toEqual(200);
      expect(firstRes.body.user.token_version).toBe(3);

      // Second redeem of the SAME token: SELECT(user), UPDATE(tv: 3 -> 4)
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 3
        }],
        rowCount: 1
      });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 4
        }],
        rowCount: 1
      });

      const secondRes = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });
      expect(secondRes.statusCode).toEqual(200);
      expect(secondRes.body.user.token_version).toBe(4);
    });

    it('treats legacy users with tier=admin + role=user as non-admin (authMiddleware parity)', async () => {
      // normalizeRole() (shared with authMiddleware) early-returns on
      // role='user' before the tier fallback ever runs, so a
      // pre-Phase-17 row with role='user', tier='admin' is treated as
      // a plain user everywhere — including authMiddleware, every
      // RBAC-guarded route, AND this redeem endpoint. The redeem MUST
      // use the same normalization so it doesn't drift; this case
      // pins the symmetric 403 + no-UPDATE behavior.
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'user', subscription_tier: 'admin'
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toBe('Admin role required');
      // Only the SELECT happened — the role check short-circuited
      // before any UPDATE. This guards against a refactor that moves
      // the rbac check below the UPDATE.
      expect(db.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('verify-folding (Phase 24 integration with the magic-link shortcut)', () => {
    it('stamps verified_at on an unverified admin so a later /login also works', async () => {
      // Phase 24 /api/auth/login refuses to mint a JWT for any unverified
      // account. Without verify-folding, an admin whose verified_at is
      // NULL would get a session JWT via the magic-link but then be
      // bounced out of the app on the next /login attempt (e.g. after a
      // logout-and-relogin cycle or a token expiry). Folding the
      // verified-stamp into the redeem UPDATE means a single click on
      // the magic-link fully transitions the admin to a verified state.
      // If verified_at was already set, the COALESCE leaves it alone.
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      // SELECT: admin exists, unverified.
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          verified_at: null
        }],
        rowCount: 1
      });
      // UPDATE: tv bumps AND verified_at set (would have been COALESCE'd).
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 7,
          verified_at: new Date('2026-07-04T23:30:00Z')
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.verified_at).toBe('2026-07-04T23:30:00.000Z');

      // Verify the SQL actually folds verified_at into the same UPDATE.
      const updateCall = db.query.mock.calls[1];
      expect(updateCall[0]).toMatch(/verified_at\s*=\s*COALESCE\s*\(\s*verified_at\s*,\s*NOW\s*\(\s*\)\s*\)/i);
      expect(updateCall[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      // RETURNING includes verified_at so the route can echo it back.
      expect(updateCall[0]).toMatch(/RETURNING.*verified_at/i);
    });

    it('preserves an already-verified admin\'s verified_at (no destructive rewrite)', async () => {
      // COALESCE(verified_at, NOW()) MUST NOT clobber an existing
      // verified_at with NOW() — otherwise every magic-link redeem for
      // an already-verified admin would silently re-stamp verification,
      // bringing Phase 24 audit-table semantics into question.
      const app = makeApp();
      const token = jwt.sign(
        { id: ADMIN_ID, email: ADMIN_EMAIL, kind: 'admin_magic' },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      const ORIGINAL_VERIFIED = new Date('2026-06-01T00:00:00Z');
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          verified_at: ORIGINAL_VERIFIED
        }],
        rowCount: 1
      });
      db.query.mockResolvedValueOnce({
        rows: [{
          id: ADMIN_ID, email: ADMIN_EMAIL,
          role: 'admin', subscription_tier: 'enterprise',
          token_version: 8,
          verified_at: ORIGINAL_VERIFIED // preserved by COALESCE
        }],
        rowCount: 1
      });

      const res = await request(app)
        .post('/api/auth/admin-magic-link/redeem')
        .send({ token });

      expect(res.statusCode).toEqual(200);
      // ISO-format serialized; must equal the original timestamp.
      expect(res.body.user.verified_at).toBe('2026-06-01T00:00:00.000Z');
    });
  });
});
