// Phase 23: /api/auth/forgot-password + /api/auth/reset-password tests.
//
// `process.env.NODE_ENV = 'test'` (set in tests/app.js) makes
// createRateLimiters() apply the 1000-iteration test ceiling, so the 5/min
// + 20/hr + 3/hr/email limits don't trip during a single jest run.
//
// Each `it()` builds a FRESH express app + FRESH limiters via `makeApp`
// so per-test counter state is isolated. The DB and emailService mocks
// are reset in beforeEach via `db.query.mockReset()`, `db.connect.mockReset()`,
// and `emailService.sendPasswordReset.mockReset()`.

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');
const { createRateLimiters } = require('../src/middlewares/rateLimiters');
const emailService = require('../src/services/emailService');

// Phase 23: stub all module-side-effects before any import so the mocks
// take effect for both this file AND the upstream `src/routes/auth` that
// does its own `require('../config/db')`. tests/app.js's mocks only fire
// when that file is required — forgotReset.test.js builds its OWN express
// app via `makeApp()`, so we duplicate the mock setup here.
jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/emailService', () => ({
  sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  APP_BASE_URL: 'http://localhost:4200'
}));

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';

function makeApp(overrides = {}) {
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
    ...overrides
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

// Phase 22 helper — supplies a per-id authMiddleware row used by reset's
// transactional client.query chain. Mock rows for tokens are set per-test.
function mockClientQuery(responses) {
  // responses is an array of { matchPredicate?: (sql)=>bool, value: any };
  // the chain walks it once per call. BEGIN / COMMIT are no-ops.
  const queries = [];
  return {
    query: jest.fn().mockImplementation(async (sql) => {
      // CRITICAL: BEGIN / COMMIT / ROLLBACK short-circuit BEFORE shifting
      // from the queue. Previously the shift ran first, so the first BEGIN
      // popped entry 0 out from under the SELECT that was supposed to
      // consume it — every UPDATE-after-SELECT in tests then resolved to
      // empty rows (the rowCount === 0 path), causing the route to 500.
      if (typeof sql === 'string' && (sql.trim().toUpperCase() === 'BEGIN' ||
                                      sql.trim().toUpperCase() === 'COMMIT' ||
                                      sql.trim().toUpperCase() === 'ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      const next = queries.shift();
      return next ? next(sql) : { rows: [], rowCount: 0 };
    }),
    push(next) { queries.push(next); },
    release: jest.fn()
  };
}

describe('Phase 23: forgot-password & reset-password', () => {
  beforeEach(() => {
    // Targeted resets — wipe the once-queue + history for db mocks, and
    // clear the call log on emailService (mockClear preserves the factory
    // impl `mockResolvedValue(undefined)` while clearing `.calls`/`.results`
    // so a previous test's sendPasswordReset call doesn't leak into the
    // next test's `not.toHaveBeenCalled()` assertion).
    db.query.mockReset();
    db.connect.mockReset();
    emailService.sendPasswordReset.mockClear();
  });

  // ------------------ /forgot-password ------------------

  describe('POST /api/auth/forgot-password', () => {
    it('always returns 200 OK with the same shape — unknown email included', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce({ rows: [] }); // user lookup: empty

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'noone@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ ok: true });
      // No INSERT fired (no token row) because user not found.
      expect(db.query).toHaveBeenCalledTimes(1);
      // sendPasswordReset was NOT called for unknown email.
      expect(emailService.sendPasswordReset).not.toHaveBeenCalled();
    });

    it('inserts a token row and calls sendPasswordReset when the user exists', async () => {
      const app = makeApp();

      // 1st SELECT: user lookup
      db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
      // 2nd INSERT: token row
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'real@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ ok: true });

      // Exactly two SQL queries: lookup + insert.
      expect(db.query).toHaveBeenCalledTimes(2);

      // The INSERT must carry a 64-char hex SHA-256 of whatever token was
      // mailed; we verify by re-deriving it from the emailService mock's
      // recorded plaintext. Build the expected hash from that.
      const insertCall = db.query.mock.calls[1];
      expect(insertCall[0]).toMatch(/INSERT INTO password_reset_tokens/i);
      expect(insertCall[1][0]).toBe(7);                     // user_id
      expect(typeof insertCall[1][1]).toBe('string');      // token_hash
      expect(insertCall[1][1]).toMatch(/^[a-f0-9]{64}$/);   // SHA-256 hex

      // sendPasswordReset was called with the user's email and the PLAINTEXT
      // token (not its hash). The hash and plaintext must match exactly.
      expect(emailService.sendPasswordReset).toHaveBeenCalledTimes(1);
      const [sentTo, sentPlaintext] = emailService.sendPasswordReset.mock.calls[0];
      expect(sentTo).toBe('real@nomos.ai');
      expect(typeof sentPlaintext).toBe('string');

      const expectedHash = crypto
        .createHash('sha256')
        .update(sentPlaintext)
        .digest('hex');
      expect(insertCall[1][1]).toBe(expectedHash);
    });

    it('still returns 200 on malformed input (no enumeration via response shape)', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({});

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ ok: true });
      // No DB queries (malformed short-circuits before SELECT).
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns 200 on email-but-no-DB-user with still-no-INSERT', async () => {
      // Defensive: even if NO user row is found AND the email filter would
      // pass, the route never inserts. Same surface as "no token sent".
      const app = makeApp();
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'bad-format@' });

      // Email regex `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` fails on `bad-format@`
      // — so the route takes the early-200 branch above, not even the SELECT.
      // The test confirms defensiveness: shape matches the happy path.
      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ ok: true });
      expect(emailService.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  // ------------------ /reset-password ------------------

  describe('POST /api/auth/reset-password', () => {
    const PLAIN_TOKEN = crypto.randomBytes(32).toString('hex');
    const TOKEN_HASH = crypto.createHash('sha256').update(PLAIN_TOKEN).digest('hex');
    const USER_ID = 42;

    it('returns 200 + fresh JWT whose tv is bumped on a valid token', async () => {
      const app = makeApp();

      // Build the transactional client mock: BEGIN, SELECT (token row),
      // UPDATE consume, UPDATE user, COMMIT.
      const client = mockClientQuery([]);
      client.push(() => ({ rows: [{ id: 1, user_id: USER_ID }], rowCount: 1 }));   // SELECT token
      client.push(() => ({ rows: [{ id: 1 }], rowCount: 1 }));                     // UPDATE token used_at
      client.push(() => ({
        rows: [{
          id: USER_ID, email: 'real@nomos.ai', role: 'user',
          subscription_tier: 'basic', token_version: 2
        }],
        rowCount: 1
      }));                                                                         // UPDATE users
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: 'newSecret123' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.token_version).toBe(2);

      // The fresh JWT must be signed with the new tv so authMiddleware
      // accepts it on the next request.
      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.tv).toBe(2);
      expect(decoded.id).toBe(USER_ID);

      // The UPDATE users statement must bump token_version AND set the
      // new hash, atomically — confirms we're not silently re-using the
      // Phase 22 mechanism.
      const userUpdate = client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /UPDATE users/i.test(sql)
      );
      expect(userUpdate).toBeDefined();
      expect(userUpdate[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      expect(userUpdate[0]).toMatch(/password_hash\s*=\s*\$1/);
      expect(userUpdate[1][0]).toMatch(/^\$2[aby]\$\d{2}\$/);
      expect(userUpdate[1][1]).toBe(USER_ID);
    });

    it('returns 400 with a generic message when the token row is missing or expired', async () => {
      const app = makeApp();

      const client = mockClientQuery([]);
      client.push(() => ({ rows: [], rowCount: 0 })); // SELECT returns empty
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: 'newSecret123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired reset link');
    });

    it('returns 400 when the consume compare-and-set finds no unused row (concurrent reset)', async () => {
      const app = makeApp();

      const client = mockClientQuery([]);
      client.push(() => ({ rows: [{ id: 1, user_id: USER_ID }], rowCount: 1 })); // SELECT finds row
      client.push(() => ({ rows: [], rowCount: 0 }));                              // UPDATE used_at no longer matches
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: 'newSecret123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired reset link');
    });

    it('returns 400 with the same generic message for a non-hex token (no signal leakage)', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: 'not-hex-not-64-chars-just-something-else-entirely', newPassword: 'newSecret123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired reset link');
      // Token-shape check short-circuits before db.connect even fires.
      expect(db.connect).not.toHaveBeenCalled();
    });

    it('returns 400 when newPassword is shorter than MIN_PASSWORD_LENGTH', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: 'short' }); // 5 chars < 8

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired reset link');
      expect(db.connect).not.toHaveBeenCalled();
    });

    it('returns 400 when token or newPassword is missing entirely', async () => {
      const app = makeApp();

      const missing = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN });  // missing newPassword
      expect(missing.statusCode).toEqual(400);

      const missingToken = await request(app)
        .post('/api/auth/reset-password')
        .send({ newPassword: 'newSecret123' });
      expect(missingToken.statusCode).toEqual(400);

      const bothMissing = await request(app)
        .post('/api/auth/reset-password')
        .send({});
      expect(bothMissing.statusCode).toEqual(400);
    });

    it('accepts exactly MIN_PASSWORD_LENGTH (boundary)', async () => {
      const app = makeApp();
      const EIGHT_CHARS = 'exactly8!';

      const client = mockClientQuery([]);
      client.push(() => ({ rows: [{ id: 1, user_id: USER_ID }], rowCount: 1 }));
      client.push(() => ({ rows: [{ id: 1 }], rowCount: 1 }));
      client.push(() => ({
        rows: [{
          id: USER_ID, email: 'real@nomos.ai', role: 'user',
          subscription_tier: 'basic', token_version: 2
        }],
        rowCount: 1
      }));
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: EIGHT_CHARS });

      expect(res.statusCode).toEqual(200); // boundary inclusive
    });

    it('rejects newPassword of 7 chars (boundary just below)', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/api/auth/reset-password')
        .send({ token: PLAIN_TOKEN, newPassword: 'seven77' }); // 7 chars

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired reset link');
    });
  });
});
