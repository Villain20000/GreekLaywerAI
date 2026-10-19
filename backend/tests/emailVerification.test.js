// Phase 24: /api/auth/verify-email + /api/auth/resend-verification tests.
//
// `process.env.NODE_ENV = 'test'` (set in tests/app.js) makes
// createRateLimiters() apply the 1000-iteration test ceiling, so the 5/min
// + 20/hr + 3/hr/email limits don't trip during a single jest run.
//
// Each `it()` builds a FRESH express app + FRESH limiters via `makeApp` so
// per-test counter state is isolated. The DB and emailService mocks are
// reset in beforeEach.

// Pin NODE_ENV='test' BEFORE the first require of application source.
// This suite builds its own express app (makeApp) instead of using
// tests/app.js, so it cannot rely on that harness's pin. Without it the
// ambient environment decides the outcome: `../src/routes/auth` pulls in
// authMiddleware (which refuses to load when NODE_ENV=production and
// JWT_SECRET is unset/default) and emailService (which hard-throws in
// production without a full SMTP configuration), so the whole suite dies
// at import time. Same idiom as the ~30 sibling suites.
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');
const { AUTH_ERROR_CODES } = require('../src/constants/authErrors');
const { createRateLimiters } = require('../src/middlewares/rateLimiters');
const emailService = require('../src/services/emailService');

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';

// Phase 24: stub all module-side-effects before any import so the mocks
// take effect for both this file AND the upstream `src/routes/auth` that
// does its own `require('../config/db')` and `require('../services/emailService')`.
jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/emailService', () => ({
  sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  APP_BASE_URL: 'http://localhost:4200'
}));

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
    verifyEmailIpMax: 100,
    resendIpMaxMin: 100,
    resendEmailMax: 100,
    ...overrides
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

// Phase 23 / 24 helper — transactional client mock. BEGIN / COMMIT /
// ROLLBACK short-circuit BEFORE shifting the once-queue. The earlier
// (incorrect) ordering consumed entry 0 on every BEGIN, breaking the
// 3-shift SELECT/UPDATE/UPDATE chain.
function mockClientQuery() {
  const queries = [];
  return {
    query: jest.fn().mockImplementation(async (sql) => {
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

describe('Phase 24: email verification', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
    // mockClear: clears call history but keeps the factory-set impl
    // `mockResolvedValue(undefined)`. mockReset would wipe the impl too.
    emailService.sendEmailVerification.mockClear();
  });

  // ------------------ /register ------------------

  describe('POST /api/auth/register (verification-enabled)', () => {
    it('INSERTs an email_verification_tokens row with sha256(token) and returns requires_verification:true', async () => {
      const app = makeApp();
      // SELECT FOR UPDATE existing: empty
      db.query.mockResolvedValueOnce({ rows: [] });
      // INSERT users RETURNING
      db.query.mockResolvedValueOnce({
        rows: [{ id: 11, email: 'new@nomos.ai', role: 'user', subscription_tier: 'basic', token_version: 1 }]
      });
      // INSERT email_verification_tokens (needs no rows)
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'new@nomos.ai', password: 'password123' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.requires_verification).toBe(true);
      // Phase 24: register intentionally does NOT return a token.
      expect(res.body.token).toBeUndefined();
      expect(res.body.user.verified_at).toBeNull();

      // Three queries must have fired (SELECT FOR UPDATE + INSERT users +
      // INSERT email_verification_tokens).
      expect(db.query.mock.calls.length).toBeGreaterThanOrEqual(3);

      // Verify the INSERT into email_verification_tokens used sha256-hex.
      const insertCall = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe(11); // user_id from upstream INSERT returning row
      expect(insertCall[1][1]).toMatch(/^[a-f0-9]{64}$/);
      // expires_at > now()
      const expires = new Date(insertCall[1][2]);
      expect(Number.isFinite(expires.getTime())).toBe(true);
      expect(expires.getTime()).toBeGreaterThan(Date.now());

      // sendEmailVerification was called with the user's email + the
      // PLAINTEXT token (re-derive the hash from it and verify shape).
      expect(emailService.sendEmailVerification).toHaveBeenCalledTimes(1);
      const [sentTo, sentPlaintext] = emailService.sendEmailVerification.mock.calls[0];
      expect(sentTo).toBe('new@nomos.ai');
      expect(typeof sentPlaintext).toBe('string');

      const expectedHash = crypto
        .createHash('sha256')
        .update(sentPlaintext)
        .digest('hex');
      expect(insertCall[1][1]).toBe(expectedHash);
    });

    it('returns 400 when the email is already in users (no token row inserted)', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // existing user found

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'taken@nomos.ai', password: 'password123' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('User already exists');
      expect(res.body.code).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);
      // No second INSERT, no email sent, no token row.
      expect(emailService.sendEmailVerification).not.toHaveBeenCalled();
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCalls.length).toBe(0);
    });
  });

  // ------------------ /verify-email ------------------

  describe('POST /api/auth/verify-email', () => {
    const PLAIN_TOKEN = crypto.randomBytes(32).toString('hex');
    const USER_ID = 88;

    it('returns 200 with a fresh JWT whose tv is bumped when the token is valid', async () => {
      const app = makeApp();

      const client = mockClientQuery();
      client.push(() => ({ rows: [{ id: 1, user_id: USER_ID }], rowCount: 1 }));   // SELECT token
      client.push(() => ({ rows: [{ id: 1 }], rowCount: 1 }));                     // UPDATE used_at
      client.push(() => ({                                                            // UPDATE users
        rows: [{
          id: USER_ID, email: 'real@nomos.ai', role: 'user',
          subscription_tier: 'basic', token_version: 2,
          verified_at: new Date('2026-01-01T00:00:00Z')
        }],
        rowCount: 1
      }));
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.user.token_version).toBe(2);
      expect(res.body.user.verified_at).toBeTruthy();

      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.tv).toBe(2);
      expect(decoded.id).toBe(USER_ID);

      // The atomic UPDATE users statement must set verified_at = NOW()
      // AND bump token_version, all in one transaction.
      const userUpdate = client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /UPDATE users/i.test(sql)
      );
      expect(userUpdate).toBeDefined();
      expect(userUpdate[0]).toMatch(/verified_at\s*=\s*NOW/);
      expect(userUpdate[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      expect(userUpdate[1][0]).toBe(USER_ID);
    });

    it('returns 400 with a generic message when the token row is missing, expired, or consumed', async () => {
      const app = makeApp();
      const client = mockClientQuery();
      client.push(() => ({ rows: [], rowCount: 0 })); // SELECT returns empty
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired verification link');
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_TOKEN);
    });

    it('returns 400 for a non-hex token without touching the DB', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({ token: 'not-hex-not-64-chars-pad-pad-pad-pad-pad-pad-pad-pad' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired verification link');
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_TOKEN);
      expect(db.connect).not.toHaveBeenCalled();
    });

    it('returns 400 when token is missing entirely', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/auth/verify-email')
        .send({});

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired verification link');
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_TOKEN);
    });
  });

  // ------------------ /resend-verification ------------------

  describe('POST /api/auth/resend-verification', () => {
    it('always returns 200 OK and INSERTS a fresh token row + sends email when the email belongs to an unverified user', async () => {
      const app = makeApp();
      // SELECT user by email
      db.query.mockResolvedValueOnce({
        rows: [{ id: 4, verified_at: null }]
      });
      // INSERT email_verification_tokens
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'real@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({
        ok: true,
        code: AUTH_ERROR_CODES.REQUEST_ACCEPTED
      });

      const insertCall = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe(4); // user_id from SELECT
      expect(insertCall[1][1]).toMatch(/^[a-f0-9]{64}$/);

      expect(emailService.sendEmailVerification).toHaveBeenCalledTimes(1);
    });

    it('returns 200 OK without sending an email when the email does not belong to any user (anti-enumeration)', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce({ rows: [] }); // SELECT returns empty

      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'noone@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({
        ok: true,
        code: AUTH_ERROR_CODES.REQUEST_ACCEPTED
      });

      expect(emailService.sendEmailVerification).not.toHaveBeenCalled();
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCalls.length).toBe(0);
    });

    it('returns 200 OK without sending an email when the account is already verified (anti-spam)', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce({
        rows: [{ id: 4, verified_at: new Date('2026-01-01') }]
      });

      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'already@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({
        ok: true,
        code: AUTH_ERROR_CODES.REQUEST_ACCEPTED
      });

      expect(emailService.sendEmailVerification).not.toHaveBeenCalled();
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_verification_tokens/i.test(sql)
      );
      expect(insertCalls.length).toBe(0);
    });

    it('still returns 200 with no DB hits when the body is malformed', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({});

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({
        ok: true,
        code: AUTH_ERROR_CODES.REQUEST_ACCEPTED
      });
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns a byte-identical body AND code for known vs unknown emails (anti-enumeration)', async () => {
      // /resend-verification must not reveal whether an address has an
      // account. The machine-readable `code` therefore has to be the SAME
      // generic value on every path — a per-outcome code (e.g.
      // 'email_exists' vs 'email_unknown') would be an enumeration oracle.
      const app = makeApp();

      // Known + unverified address → token row minted, email sent.
      db.query.mockResolvedValueOnce({ rows: [{ id: 4, verified_at: null }] });
      db.query.mockResolvedValueOnce({ rows: [] });
      const known = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'real@nomos.ai' });

      // Unknown address → no row, no email.
      db.query.mockResolvedValueOnce({ rows: [] });
      const unknown = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'noone@nomos.ai' });

      expect(known.statusCode).toEqual(unknown.statusCode);
      expect(known.body).toEqual(unknown.body);
      expect(known.body.code).toBe('request_accepted');
      expect(unknown.body.code).toBe('request_accepted');
      expect(known.body.code).toBe(AUTH_ERROR_CODES.REQUEST_ACCEPTED);
    });

    it('returns the same generic code for an already-verified address as for an unknown one', async () => {
      // Third outcome, same generic answer.
      const app = makeApp();
      db.query.mockResolvedValueOnce({
        rows: [{ id: 4, verified_at: new Date('2026-01-01') }]
      });

      const res = await request(app)
        .post('/api/auth/resend-verification')
        .send({ email: 'already@nomos.ai' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.REQUEST_ACCEPTED);
    });
  });
});
