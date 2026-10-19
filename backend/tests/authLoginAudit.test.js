// 1-11: failed-login auditing.
//
// /api/auth/login must record every credential failure in `audit_log`
// (action 'auth.login_failed') WITHOUT changing the client-visible response
// (both failure kinds stay a byte-identical 400 "Invalid credentials" so no
// account-enumeration oracle is introduced). The password must never reach
// the audit payload.
//
// auditLog is mocked here (same shape as tests/app.js) so assertions target
// the call arguments rather than the INSERT.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const db = require('../src/config/db');
const { buildAuthRouter } = require('../src/routes/auth');
const { AUTH_ERROR_CODES } = require('../src/constants/authErrors');
const { createRateLimiters } = require('../src/middlewares/rateLimiters');
const { logAudit } = require('../src/services/auditLog');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue([]),
  deleteAuditLogsForUser: jest.fn().mockResolvedValue(undefined)
}));

const PASSWORD_HASH = bcrypt.hashSync('correct-password', 4);

function makeApp() {
  const limiters = createRateLimiters({
    isTest: false, // production caps, but the in-memory store (no Redis in jest)
    loginMax: 1000, // these tests are about audit behavior, not the limiter
    registerMax: 1000,
    cpIpMax: 1000,
    cpAccountMax: 1000,
    cpAccountDailyMax: 1000,
    forgotIpMaxMin: 1000,
    forgotIpMaxHour: 1000,
    forgotEmailMax: 1000,
    resetIpMax: 1000,
    verifyEmailIpMax: 1000,
    resendIpMax: 1000,
    resendEmailMax: 1000
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', buildAuthRouter({ limiters }));
  return app;
}

function verifiedUserRow(overrides = {}) {
  return {
    id: 2,
    email: overrides.email ?? 'user@nomos.ai',
    password_hash: PASSWORD_HASH,
    role: 'user',
    subscription_tier: 'basic',
    token_version: 1,
    verified_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides
  };
}

describe('1-11: failed-login audit trail (/api/auth/login)', () => {
  beforeEach(() => {
    db.query.mockReset();
    logAudit.mockClear();
  });

  it('audits an unknown email with reason=unknown_email (normalized)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT user by email → none

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: '  Ghost@Nomos.AI ', password: 'some-secret-pw' });

    // Client response is unchanged: generic 400, no enumeration signal.
    expect(res.statusCode).toEqual(400);
    expect(res.body).toEqual({
      error: 'Invalid credentials',
      code: AUTH_ERROR_CODES.INVALID_CREDENTIALS
    });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: 'ghost@nomos.ai', // trimmed + lowercased, like the SELECT
        ipAddress: expect.any(String),
        newValue: { reason: 'unknown_email' }
      })
    );

    // The submitted password must never be part of the audit payload.
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('some-secret-pw');
  });

  it('audits a bad password with reason=bad_password', async () => {
    db.query.mockResolvedValueOnce({ rows: [verifiedUserRow()] });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'user@nomos.ai', password: 'wrong-secret-pw' });

    expect(res.statusCode).toEqual(400);
    expect(res.body).toEqual({
      error: 'Invalid credentials',
      code: AUTH_ERROR_CODES.INVALID_CREDENTIALS
    });

    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login_failed',
        resourceType: 'user',
        resourceId: 'user@nomos.ai', // trimmed + lowercased, like the SELECT
        ipAddress: expect.any(String),
        newValue: { reason: 'bad_password' }
      })
    );
    expect(JSON.stringify(logAudit.mock.calls)).not.toContain('wrong-secret-pw');
    // No user id in the payload — the same shape as the unknown-email branch.
    const entry = logAudit.mock.calls[0][0];
    expect(entry.userId).toBeUndefined();
  });

  it('keeps the two failure responses byte-identical (no enumeration)', async () => {
    const app = makeApp();

    db.query.mockResolvedValueOnce({ rows: [] });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@nomos.ai', password: 'x-password' });

    db.query.mockResolvedValueOnce({ rows: [verifiedUserRow()] });
    const badPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@nomos.ai', password: 'x-password' });

    expect(unknown.statusCode).toEqual(badPassword.statusCode);
    expect(unknown.body).toEqual(badPassword.body);

    const reasons = logAudit.mock.calls.map(([entry]) => entry.newValue.reason);
    expect(reasons).toEqual(['unknown_email', 'bad_password']);
  });

  it('does NOT write a login_failed audit entry for a successful login', async () => {
    db.query.mockResolvedValueOnce({ rows: [verifiedUserRow()] });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'user@nomos.ai', password: 'correct-password' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.token).toBeDefined();
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_failed' })
    );
  });

  it('does NOT audit the unverified-account rejection (correct credentials)', async () => {
    db.query.mockResolvedValueOnce({ rows: [verifiedUserRow({ verified_at: null })] });

    const res = await request(makeApp())
      .post('/api/auth/login')
      .send({ email: 'user@nomos.ai', password: 'correct-password' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/Email not verified/);
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login_failed' })
    );
  });
});
