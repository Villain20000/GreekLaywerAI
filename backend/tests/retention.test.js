// 1-5: Retention scheduler tests.
//
// Covers the retention service (semantics, isolation, audit summary) and
// the standalone retentionCleanup CLI (zero-row + multi-row summaries),
// all against a mocked db.

const db = require('../src/config/db');
const retention = require('../src/services/retention');
const { main } = require('../src/scripts/retentionCleanup');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

/**
 * Route mock rowCounts by statement so a full runRetention() sweep (three
 * DELETEs + the audit_log INSERT) can be exercised. Defaults to zero rows.
 */
function mockRowCounts({ accounts = 0, conversations = 0, documents = 0, auditLog = 0 } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/DELETE FROM users/.test(s)) {
      return {
        rows: Array.from({ length: accounts }, (_, i) => ({
          id: i + 1,
          email: `user${i + 1}@nomos.ai`
        })),
        rowCount: accounts
      };
    }
    if (/DELETE FROM conversations/.test(s)) return { rows: [], rowCount: conversations };
    if (/DELETE FROM legal_documents\b/.test(s)) return { rows: [], rowCount: documents };
    if (/DELETE FROM audit_log/.test(s)) return { rows: [], rowCount: auditLog };
    if (/INSERT INTO audit_log/.test(s)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

function deleteCalls() {
  return db.query.mock.calls.filter(([sql]) => /DELETE FROM/.test(String(sql)));
}

function auditInsertCalls() {
  return db.query.mock.calls.filter(([sql]) => /INSERT INTO audit_log/.test(String(sql)));
}

describe('retention service (1-5)', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('prunes conversations by updated_at and documents/audit_log by created_at', async () => {
    mockRowCounts({ accounts: 2, conversations: 5, documents: 3, auditLog: 7 });

    const summary = await retention.runRetention();

    expect(summary).toEqual({ accounts: 2, conversations: 5, documents: 3, auditLog: 7 });

    const calls = deleteCalls();
    expect(calls).toHaveLength(4);

    const accountsSql = String(calls[0][0]);
    expect(accountsSql).toMatch(/DELETE FROM users/);
    expect(accountsSql).toMatch(/deletion_scheduled_for <= NOW\(\)/);
    expect(accountsSql).toMatch(/RETURNING id, email/);

    const conversationsSql = String(calls[1][0]);
    expect(conversationsSql).toMatch(/DELETE FROM conversations/);
    expect(conversationsSql).toMatch(/updated_at < NOW\(\)/);
    expect(calls[1][1]).toEqual([365]);

    const documentsSql = String(calls[2][0]);
    expect(documentsSql).toMatch(/DELETE FROM legal_documents/);
    expect(documentsSql).toMatch(/created_at < NOW\(\)/);
    expect(calls[2][1]).toEqual([365]);

    const auditSql = String(calls[3][0]);
    expect(auditSql).toMatch(/DELETE FROM audit_log/);
    expect(auditSql).toMatch(/created_at < NOW\(\)/);
    expect(calls[3][1]).toEqual([90]);
  });

  it('records the per-table summary in the audit log', async () => {
    mockRowCounts({ conversations: 5, documents: 3, auditLog: 7 });

    await retention.runRetention();

    const inserts = auditInsertCalls();
    expect(inserts).toHaveLength(1);
    const params = inserts[0][1];
    expect(params[1]).toBe('retention.cleanup');
    expect(params[2]).toBe('system');
    expect(JSON.parse(params[5])).toEqual({
      accounts: 0,
      conversations: 5,
      documents: 3,
      auditLog: 7
    });
  });

  it('returns all-zero counts for an empty sweep and still audits', async () => {
    mockRowCounts({});

    const summary = await retention.runRetention();

    expect(summary).toEqual({ accounts: 0, conversations: 0, documents: 0, auditLog: 0 });
    expect(auditInsertCalls()).toHaveLength(1);
  });

  it('isolates a failing leg, reports -1 for it, and keeps the others', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/DELETE FROM conversations/.test(s)) throw new Error('db down');
      if (/DELETE FROM legal_documents\b/.test(s)) return { rows: [], rowCount: 2 };
      if (/DELETE FROM audit_log/.test(s)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO audit_log/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const summary = await retention.runRetention();

    expect(summary).toEqual({ accounts: 0, conversations: -1, documents: 2, auditLog: 1 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('conversations cleanup failed'),
      'db down'
    );
    // The summary is still recorded, -1 included.
    const params = auditInsertCalls()[0][1];
    expect(JSON.parse(params[5]).conversations).toBe(-1);
    errorSpy.mockRestore();
  });

  it('still resolves when the audit summary write fails (logAudit is fail-open)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/INSERT INTO audit_log/.test(s)) throw new Error('audit unavailable');
      return { rows: [], rowCount: 0 };
    });

    const summary = await retention.runRetention();

    expect(summary).toEqual({ accounts: 0, conversations: 0, documents: 0, auditLog: 0 });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('logAudit failed'),
      'audit unavailable'
    );
    errorSpy.mockRestore();
  });

  describe('retentionDays', () => {
    afterEach(() => {
      delete process.env.RETENTION_TEST_DAYS;
    });

    it('parses a positive integer env override', () => {
      process.env.RETENTION_TEST_DAYS = '30';
      expect(retention.retentionDays('RETENTION_TEST_DAYS', 365)).toBe(30);
    });

    it('falls back on missing, invalid, zero, or negative values', () => {
      expect(retention.retentionDays('RETENTION_TEST_DAYS', 365)).toBe(365);
      for (const bad of ['abc', '0', '-10']) {
        process.env.RETENTION_TEST_DAYS = bad;
        expect(retention.retentionDays('RETENTION_TEST_DAYS', 365)).toBe(365);
      }
    });
  });
});

describe('retentionCleanup CLI (1-5)', () => {
  let logSpy;

  beforeEach(() => {
    db.query.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('logs zero-row counts for an empty sweep', async () => {
    mockRowCounts({});

    const summary = await main();

    expect(summary).toEqual({ accounts: 0, conversations: 0, documents: 0, auditLog: 0 });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('conversations=0 documents=0 audit_log=0')
    );
  });

  it('logs per-table counts for a multi-row sweep and returns them', async () => {
    mockRowCounts({ conversations: 5, documents: 3, auditLog: 7 });

    const summary = await main();

    expect(summary).toEqual({ accounts: 0, conversations: 5, documents: 3, auditLog: 7 });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('conversations=5 documents=3 audit_log=7')
    );
  });
});
