// Account-deletion grace period: scheduling, cancellation, status and the
// retention purge. Routes run through the real gdpr router; db/email/audit
// are the shared test doubles from tests/app.js.

process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const emailService = require('../src/services/emailService');
const { logAudit } = require('../src/services/auditLog');
const retention = require('../src/services/retention');

const JWT_SECRET = 'nomos-super-secret-key-development';
const SCHEDULED = new Date('2026-10-20T12:00:00.000Z');
const SCHEDULED_ISO = SCHEDULED.toISOString();

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

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
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
}

function scheduleRequest() {
  return request(app)
    .delete('/api/gdpr/account')
    .set('Authorization', `Bearer ${userToken()}`)
    .send({ confirm: true, email: 'user@nomos.ai' });
}

describe('DELETE /api/gdpr/account (grace period)', () => {
  beforeEach(() => {
    db.query.mockReset();
    emailService.sendAccountDeletionScheduled.mockClear();
    logAudit.mockClear();
  });

  afterEach(() => {
    delete process.env.ACCOUNT_DELETION_GRACE_HOURS;
  });

  it('schedules deletion, emails the deadline, audits, and deletes nothing', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: null }], rowCount: 0 });
    db.query.mockResolvedValueOnce({
      rows: [{ deletion_scheduled_for: SCHEDULED }],
      rowCount: 1
    });

    const res = await scheduleRequest();

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({
      ok: true,
      deletionScheduledFor: SCHEDULED_ISO,
      graceHours: 24
    });

    const update = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE users/.test(sql)
    );
    expect(update).toBeDefined();
    expect(update[0]).toMatch(/SET deletion_scheduled_for = CURRENT_TIMESTAMP \+ \(\$2::int \* INTERVAL '1 hour'\)/);
    expect(update[1]).toEqual([2, 24]);

    expect(emailService.sendAccountDeletionScheduled).toHaveBeenCalledWith(
      'user@nomos.ai',
      SCHEDULED_ISO
    );
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2,
      action: 'account.deletion_scheduled',
      resourceType: 'user',
      resourceId: 2,
      newValue: { deletionScheduledFor: SCHEDULED_ISO, graceHours: 24 }
    }));

    expect(db.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && /DELETE FROM users/.test(sql)
    )).toBe(false);
  });

  it('rejects confirm:false without scheduling or emailing', async () => {
    queueAuth();

    const res = await request(app)
      .delete('/api/gdpr/account')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ confirm: false, email: 'user@nomos.ai' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/confirm/i);
    expect(emailService.sendAccountDeletionScheduled).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && /UPDATE users/.test(sql)
    )).toBe(false);
  });

  it('rejects a mismatched email without scheduling or emailing', async () => {
    queueAuth();

    const res = await request(app)
      .delete('/api/gdpr/account')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ confirm: true, email: 'other@nomos.ai' });

    expect(res.statusCode).toEqual(400);
    expect(emailService.sendAccountDeletionScheduled).not.toHaveBeenCalled();
  });

  it('is idempotent: an existing deadline is returned unchanged', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ deletion_scheduled_for: SCHEDULED }],
      rowCount: 1
    });

    const res = await scheduleRequest();

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({
      ok: true,
      deletionScheduledFor: SCHEDULED_ISO,
      graceHours: 24,
      alreadyScheduled: true
    });
    expect(db.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && /UPDATE users/.test(sql)
    )).toBe(false);
    expect(emailService.sendAccountDeletionScheduled).not.toHaveBeenCalled();
  });

  it('clamps the configured grace period to 168 hours', async () => {
    process.env.ACCOUNT_DELETION_GRACE_HOURS = '500';
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: null }], rowCount: 0 });
    db.query.mockResolvedValueOnce({
      rows: [{ deletion_scheduled_for: SCHEDULED }],
      rowCount: 1
    });

    const res = await scheduleRequest();

    expect(res.statusCode).toEqual(200);
    expect(res.body.graceHours).toBe(168);
    const update = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE users/.test(sql)
    );
    expect(update[1]).toEqual([2, 168]);
  });

  it('falls back to 24 hours for a non-finite configuration', async () => {
    process.env.ACCOUNT_DELETION_GRACE_HOURS = 'not-a-number';
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: null }], rowCount: 0 });
    db.query.mockResolvedValueOnce({
      rows: [{ deletion_scheduled_for: SCHEDULED }],
      rowCount: 1
    });

    const res = await scheduleRequest();

    expect(res.statusCode).toEqual(200);
    expect(res.body.graceHours).toBe(24);
  });

  it('still succeeds when the notification email fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    emailService.sendAccountDeletionScheduled.mockRejectedValueOnce(new Error('smtp down'));
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: null }], rowCount: 0 });
    db.query.mockResolvedValueOnce({
      rows: [{ deletion_scheduled_for: SCHEDULED }],
      rowCount: 1
    });

    const res = await scheduleRequest();

    expect(res.statusCode).toEqual(200);
    expect(res.body.deletionScheduledFor).toBe(SCHEDULED_ISO);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('deletion-scheduled email failed'),
      'smtp down'
    );
    errorSpy.mockRestore();
  });
});

describe('POST /api/gdpr/cancel-deletion', () => {
  beforeEach(() => {
    db.query.mockReset();
    logAudit.mockClear();
  });

  it('clears a pending deadline and audits the cancellation', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 });

    const res = await request(app)
      .post('/api/gdpr/cancel-deletion')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ ok: true });

    const update = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE users/.test(sql)
    );
    expect(update[0]).toMatch(/SET deletion_scheduled_for = NULL/);
    expect(update[0]).toMatch(/deletion_scheduled_for IS NOT NULL/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2,
      action: 'account.deletion_cancelled',
      resourceType: 'user',
      resourceId: 2
    }));
    expect(db.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && /DELETE FROM/.test(sql)
    )).toBe(false);
  });

  it('returns 409 when no deletion is scheduled', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/gdpr/cancel-deletion')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(409);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('GET /api/gdpr/deletion-status', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('returns the scheduled deadline', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: SCHEDULED }] });

    const res = await request(app)
      .get('/api/gdpr/deletion-status')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ deletionScheduledFor: SCHEDULED_ISO });
  });

  it('returns null when no deletion is scheduled', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ deletion_scheduled_for: null }] });

    const res = await request(app)
      .get('/api/gdpr/deletion-status')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ deletionScheduledFor: null });
  });
});

describe('retention: scheduled account deletions', () => {
  beforeEach(() => {
    db.query.mockReset();
    logAudit.mockClear();
  });

  it('purges only expired deadlines and audits each deleted account', async () => {
    const purgedRows = [{ id: 7, email: 'gone@nomos.ai' }];
    db.query.mockResolvedValueOnce({ rows: purgedRows, rowCount: 1 });

    const purged = await retention.cleanupScheduledDeletions();

    expect(purged).toEqual(purgedRows);
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toMatch(/DELETE FROM users/);
    expect(sql).toMatch(/deletion_scheduled_for IS NOT NULL/);
    expect(sql).toMatch(/deletion_scheduled_for <= NOW\(\)/);
    expect(sql).toMatch(/RETURNING id, email/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      action: 'account.deletion_purged',
      resourceType: 'user',
      resourceId: 7,
      newValue: { email: 'gone@nomos.ai' }
    }));
  });

  it('runs the account purge first and includes accounts in the sweep summary', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/DELETE FROM users/.test(s)) {
        return { rows: [{ id: 1, email: 'a@nomos.ai' }, { id: 2, email: 'b@nomos.ai' }], rowCount: 2 };
      }
      if (/DELETE FROM conversations/.test(s)) return { rows: [], rowCount: 3 };
      if (/DELETE FROM legal_documents\b/.test(s)) return { rows: [], rowCount: 4 };
      if (/DELETE FROM audit_log/.test(s)) return { rows: [], rowCount: 5 };
      return { rows: [], rowCount: 0 };
    });

    const summary = await retention.runRetention();

    expect(summary).toEqual({ accounts: 2, conversations: 3, documents: 4, auditLog: 5 });

    const deleteSql = db.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /DELETE FROM/.test(sql));
    expect(deleteSql[0]).toMatch(/DELETE FROM users/);
    expect(deleteSql[deleteSql.length - 1]).toMatch(/DELETE FROM audit_log/);
    expect(deleteSql[deleteSql.length - 1]).toMatch(/created_at < NOW\(\)/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'retention.cleanup',
      newValue: { accounts: 2, conversations: 3, documents: 4, auditLog: 5 }
    }));
  });
});
