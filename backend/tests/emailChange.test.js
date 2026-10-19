// Phase 30: /api/auth/change-email + /api/auth/verify-email-change tests.
//
// Same harness idiom as emailVerification.test.js: a fresh express app +
// fresh limiters per test, a mocked db (query + connect) and mocked
// emailService / auditLog modules installed before any application import.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');
const { AUTH_ERROR_CODES } = require('../src/constants/authErrors');
const { createRateLimiters } = require('../src/middlewares/rateLimiters');
const emailService = require('../src/services/emailService');
const { logAudit } = require('../src/services/auditLog');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/emailService', () => ({
  sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  sendEmailChangeVerification: jest.fn().mockResolvedValue(undefined),
  APP_BASE_URL: 'http://localhost:4200'
}));
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined)
}));

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';
const USER_ID = 7;
const OLD_EMAIL = 'old@nomos.ai';
const NEW_EMAIL = 'new@nomos.ai';
const CURRENT_PASSWORD = 'correct-horse-battery';
const PASSWORD_HASH = bcrypt.hashSync(CURRENT_PASSWORD, 4);

function makeApp(overrides = {}) {
  const limiters = createRateLimiters({
    isTest: false,
    registerMax: 100,
    loginMax: 100,
    cpIpMax: 100,
    cpAccountMax: 100,
    cpAccountDailyMax: 100,
    changeEmailIpMax: 100,
    changeEmailAccountMax: 100,
    verifyEmailChangeIpMax: 100,
    ...overrides
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

function authHeader() {
  const token = jwt.sign(
    { id: USER_ID, email: OLD_EMAIL, role: 'user', tier: 'basic', tv: 3 },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
  return `Bearer ${token}`;
}

function authMiddlewareRow(overrides = {}) {
  return {
    rows: [{
      id: USER_ID,
      email: OLD_EMAIL,
      role: 'user',
      subscription_tier: 'basic',
      created_at: new Date('2026-01-01T00:00:00Z'),
      token_version: 3,
      verified_at: new Date('2026-01-01T00:00:00Z'),
      ...overrides
    }]
  };
}

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

describe('Phase 30: email change', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.connect.mockReset();
    emailService.sendEmailChangeVerification.mockClear();
    logAudit.mockClear();
  });

  describe('POST /api/auth/change-email', () => {
    it('verifies the password, stores a sha256 token for the new address and emails it', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce(authMiddlewareRow()); // authMiddleware
      db.query.mockResolvedValueOnce({                       // live user + hash
        rows: [{ id: USER_ID, email: OLD_EMAIL, password_hash: PASSWORD_HASH }]
      });
      db.query.mockResolvedValueOnce({ rows: [] });          // new address free
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // invalidate old
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // insert token

      const res = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: ' New@Nomos.ai ' });

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ ok: true, requires_verification: true });
      expect(res.body.token).toBeUndefined();

      const insertCall = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' &&
                   /INSERT INTO email_change_tokens/i.test(sql)
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[1][0]).toBe(USER_ID);
      expect(insertCall[1][1]).toBe(NEW_EMAIL); // normalized
      expect(insertCall[1][2]).toMatch(/^[a-f0-9]{64}$/);
      const expires = new Date(insertCall[1][3]);
      expect(expires.getTime()).toBeGreaterThan(Date.now());

      expect(emailService.sendEmailChangeVerification).toHaveBeenCalledTimes(1);
      const [sentTo, plaintext] = emailService.sendEmailChangeVerification.mock.calls[0];
      expect(sentTo).toBe(NEW_EMAIL);
      const expectedHash = crypto.createHash('sha256').update(plaintext).digest('hex');
      expect(insertCall[1][2]).toBe(expectedHash);

      // users.email is untouched until verification.
      const userUpdate = db.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /UPDATE users/i.test(sql)
      );
      expect(userUpdate).toBeUndefined();

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.email_change_requested',
          resourceId: USER_ID
        })
      );
      const auditDump = JSON.stringify(logAudit.mock.calls);
      expect(auditDump).not.toContain(plaintext);
      expect(auditDump).not.toContain(CURRENT_PASSWORD);
    });

    it('returns 400 and sends nothing when the current password is wrong', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce(authMiddlewareRow());
      db.query.mockResolvedValueOnce({
        rows: [{ id: USER_ID, email: OLD_EMAIL, password_hash: PASSWORD_HASH }]
      });

      const res = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: 'wrong-password', newEmail: NEW_EMAIL });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.PASSWORD_CHANGE_FAILED);
      expect(emailService.sendEmailChangeVerification).not.toHaveBeenCalled();
      expect(
        db.query.mock.calls.filter(
          ([sql]) => typeof sql === 'string' && /email_change_tokens/i.test(sql)
        ).length
      ).toBe(0);
    });

    it('returns 409 when another account already owns the address', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce(authMiddlewareRow());
      db.query.mockResolvedValueOnce({
        rows: [{ id: USER_ID, email: OLD_EMAIL, password_hash: PASSWORD_HASH }]
      });
      db.query.mockResolvedValueOnce({ rows: [{ exists: 1 }] });

      const res = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: NEW_EMAIL });

      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);
      expect(emailService.sendEmailChangeVerification).not.toHaveBeenCalled();
    });

    it('returns 409 for a UNIQUE violation (23505) raised mid-flight', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce(authMiddlewareRow());
      db.query.mockResolvedValueOnce({
        rows: [{ id: USER_ID, email: OLD_EMAIL, password_hash: PASSWORD_HASH }]
      });
      db.query.mockResolvedValueOnce({ rows: [] });
      db.query.mockImplementationOnce(async () => {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      });

      const res = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: NEW_EMAIL });

      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);
    });

    it('returns 400 when the new address equals the current one', async () => {
      const app = makeApp();
      db.query.mockResolvedValueOnce(authMiddlewareRow());
      db.query.mockResolvedValueOnce({
        rows: [{ id: USER_ID, email: OLD_EMAIL, password_hash: PASSWORD_HASH }]
      });

      const res = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: ' OLD@Nomos.ai' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_REQUEST);
      expect(emailService.sendEmailChangeVerification).not.toHaveBeenCalled();
    });

    it('rejects malformed bodies and missing JWTs', async () => {
      const app = makeApp();

      db.query.mockResolvedValueOnce(authMiddlewareRow());
      const badBody = await request(app)
        .post('/api/auth/change-email')
        .set('Authorization', authHeader())
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: 'not-an-email' });
      expect(badBody.statusCode).toEqual(400);
      expect(badBody.body.code).toBe(AUTH_ERROR_CODES.INVALID_REQUEST);

      const noAuth = await request(app)
        .post('/api/auth/change-email')
        .send({ currentPassword: CURRENT_PASSWORD, newEmail: NEW_EMAIL });
      expect(noAuth.statusCode).toEqual(401);
    });
  });

  describe('POST /api/auth/verify-email-change', () => {
    const PLAIN_TOKEN = crypto.randomBytes(32).toString('hex');

    it('consumes the token, swaps users.email, bumps token_version and returns a fresh JWT', async () => {
      const app = makeApp();

      const client = mockClientQuery();
      client.push(() => ({
        rows: [{ id: 10, user_id: USER_ID, new_email: NEW_EMAIL }],
        rowCount: 1
      }));
      client.push(() => ({ rows: [], rowCount: 0 })); // new address still free
      client.push(() => ({ rows: [{ id: 10 }], rowCount: 1 })); // used_at
      client.push(() => ({
        rows: [{
          id: USER_ID,
          email: NEW_EMAIL,
          role: 'user',
          subscription_tier: 'basic',
          token_version: 4,
          verified_at: new Date('2026-01-01T00:00:00Z')
        }],
        rowCount: 1
      }));
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email-change')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user.email).toBe(NEW_EMAIL);
      expect(res.body.user.token_version).toBe(4);

      const decoded = jwt.verify(res.body.token, JWT_SECRET);
      expect(decoded.id).toBe(USER_ID);
      expect(decoded.email).toBe(NEW_EMAIL);
      expect(decoded.tv).toBe(4);

      const userUpdate = client.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /UPDATE users/i.test(sql)
      );
      expect(userUpdate).toBeDefined();
      expect(userUpdate[0]).toMatch(/SET email\s*=\s*\$1/);
      expect(userUpdate[0]).toMatch(/token_version\s*=\s*token_version\s*\+\s*1/);
      expect(userUpdate[1][0]).toBe(NEW_EMAIL);

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'auth.email_changed',
          resourceId: USER_ID
        })
      );
      expect(JSON.stringify(logAudit.mock.calls)).not.toContain(PLAIN_TOKEN);
    });

    it('returns 400 for a missing, expired or consumed token', async () => {
      const app = makeApp();
      const client = mockClientQuery();
      client.push(() => ({ rows: [], rowCount: 0 }));
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email-change')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toBe('Invalid or expired email-change link');
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_TOKEN);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed tokens without opening a transaction', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/auth/verify-email-change')
        .send({ token: 'not-a-64-hex-token' });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.INVALID_TOKEN);
      expect(db.connect).not.toHaveBeenCalled();
    });

    it('returns 409 and leaves users untouched when the address was claimed meanwhile', async () => {
      const app = makeApp();
      const client = mockClientQuery();
      client.push(() => ({
        rows: [{ id: 10, user_id: USER_ID, new_email: NEW_EMAIL }],
        rowCount: 1
      }));
      client.push(() => ({ rows: [{ exists: 1 }], rowCount: 1 }));
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email-change')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);

      const attemptedUpdates = client.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && /UPDATE /i.test(sql)
      );
      expect(attemptedUpdates.length).toBe(0);
      expect(client.query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK'
      )).toBe(true);
      expect(logAudit).not.toHaveBeenCalled();
    });

    it('returns 409 when the users.email UNIQUE constraint fires during the swap', async () => {
      const app = makeApp();
      const client = mockClientQuery();
      client.push(() => ({
        rows: [{ id: 10, user_id: USER_ID, new_email: NEW_EMAIL }],
        rowCount: 1
      }));
      client.push(() => ({ rows: [], rowCount: 0 }));
      client.push(() => ({ rows: [{ id: 10 }], rowCount: 1 }));
      client.push(() => {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      });
      db.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/api/auth/verify-email-change')
        .send({ token: PLAIN_TOKEN });

      expect(res.statusCode).toEqual(409);
      expect(res.body.code).toBe(AUTH_ERROR_CODES.EMAIL_TAKEN);
    });
  });
});
