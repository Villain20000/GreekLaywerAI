// 1-4: Daily quota service + middleware unit tests.
//
// These exercise the DB-backed counter semantics directly (no HTTP):
//   - UTC day key + next-midnight reset math,
//   - the single atomic ON CONFLICT UPSERT (SQL shape + params),
//   - tier boundaries (basic 20 → 21st denied, pro 60, enterprise 120),
//   - admin bypass, document caps (10/50/unlimited), fail-open on DB errors,
//   - migration idempotency/rollback and schema.sql parity.
//
// Route-level integration lives in quotaRoutes.test.js.
process.env.NODE_ENV = 'test';

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');
const quotaService = require('../src/services/quotaService');
const {
  enforceAiQuota,
  enforceDocumentCap,
  retryAfterSeconds
} = require('../src/middlewares/quotaMiddleware');
const migrate = require('../src/scripts/migrate-usage-counters');

const SCRIPTS_DIR = path.join(__dirname, '../src/scripts');
const SCHEMA_PATH = path.join(__dirname, '../../database/init/schema.sql');

const FIXED_NOW = new Date('2026-10-19T23:30:00.000Z');
const RESET_AT = '2026-10-20T00:00:00.000Z';

const QUOTA_ENV_KEYS = [
  'QUOTA_AI_BASIC',
  'QUOTA_AI_PRO',
  'QUOTA_AI_ENTERPRISE',
  'QUOTA_DOCS_BASIC',
  'QUOTA_DOCS_PRO',
  'QUOTA_DOCS_ENTERPRISE'
];

function clearQuotaEnv() {
  for (const key of QUOTA_ENV_KEYS) delete process.env[key];
}

function fakeResponse() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.setHeader = jest.fn();
  return res;
}

function aiRequest(overrides = {}) {
  return {
    user: {
      id: 2,
      role: 'user',
      subscription_tier: 'basic',
      ...overrides
    }
  };
}

let errorSpy;

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  clearQuotaEnv();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  clearQuotaEnv();
  db.query.mockReset();
  db.connect.mockReset();
});

describe('quotaService — UTC day/reset math', () => {
  it('derives the UTC day and next UTC midnight from an arbitrary instant', () => {
    expect(quotaService.utcDayKey(FIXED_NOW)).toBe('2026-10-19');
    expect(quotaService.nextUtcMidnight(FIXED_NOW).toISOString()).toBe(RESET_AT);
  });

  it('rolls over month/year boundaries in UTC', () => {
    const endOfYear = new Date('2026-12-31T23:59:59.999Z');
    expect(quotaService.utcDayKey(endOfYear)).toBe('2026-12-31');
    expect(quotaService.nextUtcMidnight(endOfYear).toISOString()).toBe('2027-01-01T00:00:00.000Z');

    const leapEve = new Date('2028-02-28T12:00:00.000Z');
    expect(quotaService.nextUtcMidnight(leapEve).toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('returns resetAt as the next UTC midnight in consumeDailyQuota', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    const result = await quotaService.consumeDailyQuota(2, 'ai', 20, { now: FIXED_NOW });
    expect(result).toEqual({ allowed: true, used: 1, limit: 20, resetAt: RESET_AT });
  });
});

describe('quotaService — atomic counter SQL', () => {
  it('uses one ON CONFLICT upsert with UTC day params', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });

    await quotaService.consumeDailyQuota(7, 'ai', 20, { now: FIXED_NOW });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO usage_counters \(user_id, day, kind, count\)/);
    expect(sql).toMatch(/VALUES \(\$1, \$2, \$3, 1\)/);
    expect(sql).toMatch(/ON CONFLICT \(user_id, day, kind\)/);
    expect(sql).toMatch(/DO UPDATE SET count = usage_counters\.count \+ 1/);
    expect(sql).toMatch(/RETURNING count/);
    expect(params).toEqual([7, '2026-10-19', 'ai']);
  });

  it('allows the 20th basic query and denies the 21st', async () => {
    let count = 0;
    db.query.mockImplementation(async () => ({ rows: [{ count: ++count }] }));

    for (let i = 1; i <= 20; i += 1) {
      const result = await quotaService.consumeDailyQuota(2, 'ai', 20, { now: FIXED_NOW });
      expect(result.allowed).toBe(true);
      expect(result.used).toBe(i);
    }

    const denied = await quotaService.consumeDailyQuota(2, 'ai', 20, { now: FIXED_NOW });
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(21);
    expect(denied.limit).toBe(20);
    expect(denied.resetAt).toBe(RESET_AT);
    expect(db.query).toHaveBeenCalledTimes(21);
  });

  it('enforces the production tier caps (20 / 60 / 120)', async () => {
    const limits = quotaService.createQuotaLimits({ isTest: false });
    expect(limits.ai).toEqual({ basic: 20, pro: 60, enterprise: 120 });
    expect(limits.documents).toEqual({ basic: 10, pro: 50, enterprise: null });

    for (const tier of ['basic', 'pro', 'enterprise']) {
      const limit = limits.ai[tier];
      for (const used of [limit - 1, limit, limit + 1]) {
        db.query.mockResolvedValueOnce({ rows: [{ count: used }] });
        const result = await quotaService.consumeDailyQuota(2, 'ai', limit, { now: FIXED_NOW });
        expect(result.allowed).toBe(used <= limit);
        expect(result.limit).toBe(limit);
      }
    }
  });

  it('blocks the first request when the limit is 0', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });
    const result = await quotaService.consumeDailyQuota(2, 'ai', 0, { now: FIXED_NOW });
    expect(result).toEqual({ allowed: false, used: 1, limit: 0, resetAt: RESET_AT });
  });

  it('treats a null/Infinity limit as unlimited but still counts', async () => {
    db.query.mockResolvedValue({ rows: [{ count: 999999 }] });
    const unlimited = await quotaService.consumeDailyQuota(2, 'ai', null, { now: FIXED_NOW });
    expect(unlimited).toEqual({ allowed: true, used: 999999, limit: null, resetAt: RESET_AT });

    const infinity = await quotaService.consumeDailyQuota(2, 'ai', Infinity, { now: FIXED_NOW });
    expect(infinity.allowed).toBe(true);
    expect(infinity.limit).toBeNull();
  });
});

describe('quotaService — limits config', () => {
  it('uses the test ceiling unless the env var is explicitly set', () => {
    delete process.env.QUOTA_AI_BASIC;
    expect(quotaService.getAiDailyLimit('basic')).toBe(quotaService.TEST_CEILING);
    expect(quotaService.getDocumentLimit('basic')).toBe(quotaService.TEST_CEILING);

    process.env.QUOTA_AI_BASIC = '7';
    process.env.QUOTA_DOCS_BASIC = '2';
    expect(quotaService.getAiDailyLimit('basic')).toBe(7);
    expect(quotaService.getDocumentLimit('basic')).toBe(2);
  });

  it('reads env lazily, so changing it after require takes effect', () => {
    process.env.QUOTA_AI_PRO = '61';
    expect(quotaService.getAiDailyLimit('pro')).toBe(61);
    process.env.QUOTA_AI_PRO = '62';
    expect(quotaService.getAiDailyLimit('pro')).toBe(62);
  });

  it('supports the "unlimited" string for document caps', () => {
    process.env.QUOTA_DOCS_ENTERPRISE = 'unlimited';
    expect(quotaService.getDocumentLimit('enterprise')).toBeNull();

    process.env.QUOTA_DOCS_ENTERPRISE = 'Unlimited';
    expect(quotaService.getDocumentLimit('enterprise')).toBeNull();
  });

  it('falls back to basic for unknown tiers and to defaults for invalid env', () => {
    delete process.env.QUOTA_AI_BASIC;
    expect(quotaService.getAiDailyLimit('platinum')).toBe(quotaService.TEST_CEILING);
    process.env.QUOTA_AI_BASIC = 'not-a-number';
    expect(quotaService.getAiDailyLimit('basic')).toBe(20);
    expect(quotaService.createQuotaLimits({ isTest: false }).ai.basic).toBe(20);
  });
});

describe('quotaService — getUsage + countUserDocuments', () => {
  it('returns 0 used when there is no counter row yet', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const usage = await quotaService.getUsage(2, 'ai', { now: FIXED_NOW, limit: 20 });
    expect(usage).toEqual({ used: 0, limit: 20, resetAt: RESET_AT });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SELECT count FROM usage_counters/);
    expect(params).toEqual([2, '2026-10-19', 'ai']);
  });

  it('returns the stored counter and degrades to 0 on a read error', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '5' }] });
    expect(await quotaService.getUsage(2, 'ai', { now: FIXED_NOW, limit: 20 })).toEqual({
      used: 5,
      limit: 20,
      resetAt: RESET_AT
    });

    db.query.mockRejectedValueOnce(new Error('db down'));
    expect(await quotaService.getUsage(2, 'ai', { now: FIXED_NOW, limit: 20 })).toEqual({
      used: 0,
      limit: 20,
      resetAt: RESET_AT
    });
    expect(errorSpy.mock.calls.some(([msg]) => String(msg).startsWith('[QUOTA] getUsage failed'))).toBe(true);
  });

  it('counts the user\'s uploaded documents scoped by owner', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    await expect(quotaService.countUserDocuments(2)).resolves.toBe(7);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int AS count FROM legal_documents WHERE user_id = \$1/);
    expect(params).toEqual([2]);
  });
});

describe('quotaService — fail-open on DB errors', () => {
  it('allows the request and logs [QUOTA] when the counter upsert throws', async () => {
    db.query.mockRejectedValueOnce(new Error('connection reset'));

    const result = await quotaService.consumeDailyQuota(2, 'ai', 20, { now: FIXED_NOW });
    expect(result).toEqual({ allowed: true, used: 0, limit: 20, resetAt: RESET_AT });
    expect(errorSpy.mock.calls.some(([msg]) =>
      String(msg).startsWith('[QUOTA] consumeDailyQuota failed')
    )).toBe(true);
  });

  it('fails open when the mocked insert returns no row', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await quotaService.consumeDailyQuota(2, 'ai', 20, { now: FIXED_NOW });
    expect(result.allowed).toBe(true);
  });
});

describe('quotaMiddleware.enforceAiQuota', () => {
  it('allows under-limit requests, sets req.quota, and calls next', async () => {
    process.env.QUOTA_AI_BASIC = '5';
    db.query.mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const req = aiRequest();
    const res = fakeResponse();
    const next = jest.fn();
    await enforceAiQuota(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.quota).toEqual({
      kind: 'ai',
      tier: 'basic',
      used: 1,
      limit: 5,
      resetAt: expect.any(String)
    });
  });

  it('returns 429 with limit/used/tier/resetAt and Retry-After on exceed', async () => {
    process.env.QUOTA_AI_BASIC = '2';
    db.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });

    const req = aiRequest();
    const res = fakeResponse();
    const next = jest.fn();
    await enforceAiQuota(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({
      error: 'Daily AI query limit reached for your plan',
      limit: 2,
      used: 3,
      tier: 'basic',
      resetAt: expect.any(String)
    });
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^\d+$/));
    expect(Number(res.setHeader.mock.calls[0][1])).toBeGreaterThanOrEqual(1);
  });

  it('uses the tier-specific cap (pro 60, enterprise 120)', async () => {
    for (const [tier, limit] of [['pro', 60], ['enterprise', 120]]) {
      process.env[`QUOTA_AI_${tier.toUpperCase()}`] = String(limit);
      db.query.mockResolvedValueOnce({ rows: [{ count: limit + 1 }] });
      const res = fakeResponse();
      await enforceAiQuota(aiRequest({ subscription_tier: tier }), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json.mock.calls[0][0]).toMatchObject({ limit, tier });
    }
  });

  it('bypasses quota entirely for admins (no counter query)', async () => {
    process.env.QUOTA_AI_BASIC = '0';
    const req = aiRequest({ role: 'admin' });
    const res = fakeResponse();
    const next = jest.fn();

    await enforceAiQuota(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('fails open when the counter service throws unexpectedly', async () => {
    process.env.QUOTA_AI_BASIC = '1';
    db.query.mockRejectedValueOnce(new Error('boom'));
    // consumeDailyQuota already catches; force the belt-and-braces path.
    const spy = jest.spyOn(quotaService, 'consumeDailyQuota').mockRejectedValueOnce(new Error('exploded'));

    const res = fakeResponse();
    const next = jest.fn();
    await enforceAiQuota(aiRequest(), res, next);

    expect(spy).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = fakeResponse();
    const next = jest.fn();
    await enforceAiQuota({}, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('quotaMiddleware.enforceDocumentCap', () => {
  it('allows uploads below the basic cap and sets req.quota', async () => {
    process.env.QUOTA_DOCS_BASIC = '10';
    db.query.mockResolvedValueOnce({ rows: [{ count: 9 }] });

    const req = aiRequest();
    const res = fakeResponse();
    const next = jest.fn();
    await enforceDocumentCap(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.quota).toEqual({ kind: 'documents', tier: 'basic', used: 9, limit: 10, resetAt: null });
  });

  it('returns 403 at the basic cap (10) and the pro cap (50)', async () => {
    for (const [tier, limit] of [['basic', 10], ['pro', 50]]) {
      process.env[`QUOTA_DOCS_${tier.toUpperCase()}`] = String(limit);
      db.query.mockResolvedValueOnce({ rows: [{ count: limit }] });
      const res = fakeResponse();
      const next = jest.fn();

      await enforceDocumentCap(aiRequest({ subscription_tier: tier }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0]).toEqual({
        error: 'Document limit reached for your plan',
        limit,
        used: limit,
        tier
      });
    }
  });

  it('never blocks an unlimited (enterprise) tier', async () => {
    process.env.QUOTA_DOCS_ENTERPRISE = 'unlimited';
    const req = aiRequest({ subscription_tier: 'enterprise' });
    const res = fakeResponse();
    const next = jest.fn();

    await enforceDocumentCap(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(req.quota).toMatchObject({ kind: 'documents', tier: 'enterprise', limit: null });
  });

  it('bypasses the document cap for admins', async () => {
    process.env.QUOTA_DOCS_BASIC = '1';
    const req = aiRequest({ role: 'admin' });
    const res = fakeResponse();
    const next = jest.fn();

    await enforceDocumentCap(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('fails open when the document count query errors', async () => {
    process.env.QUOTA_DOCS_BASIC = '1';
    db.query.mockRejectedValueOnce(new Error('db down'));
    const res = fakeResponse();
    const next = jest.fn();

    await enforceDocumentCap(aiRequest(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some(([msg]) =>
      String(msg).startsWith('[QUOTA] enforceDocumentCap failed')
    )).toBe(true);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = fakeResponse();
    const next = jest.fn();
    await enforceDocumentCap({}, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('quotaMiddleware.retryAfterSeconds', () => {
  it('rounds up and clamps to at least 1 second', () => {
    expect(retryAfterSeconds('2026-10-20T00:00:00.000Z', new Date('2026-10-19T23:30:00.000Z'))).toBe(1800);
    expect(retryAfterSeconds('2026-10-20T00:00:00.000Z', new Date('2026-10-19T23:59:59.500Z'))).toBe(1);
    expect(retryAfterSeconds('2026-10-20T00:00:00.000Z', new Date('2026-10-20T00:00:05.000Z'))).toBe(1);
    expect(retryAfterSeconds('not-a-date')).toBe(60);
  });
});

describe('migrate-usage-counters.js', () => {
  it('creates the usage_counters table in a BEGIN/COMMIT transaction', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 0 }),
      release: jest.fn()
    };
    db.connect.mockResolvedValue(client);

    const result = await migrate();

    expect(result).toEqual({ ok: true });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');

    const createSql = sqls.find((sql) => /CREATE TABLE IF NOT EXISTS usage_counters/i.test(sql));
    expect(createSql).toBeDefined();
    expect(createSql).toMatch(/user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(createSql).toMatch(/day DATE NOT NULL/);
    expect(createSql).toMatch(/kind TEXT NOT NULL/);
    expect(createSql).toMatch(/count INTEGER NOT NULL DEFAULT 0/);
    expect(createSql).toMatch(/PRIMARY KEY \(user_id, day, kind\)/);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('is idempotent (IF NOT EXISTS) and can run twice', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 0 }),
      release: jest.fn()
    };
    db.connect.mockResolvedValue(client);

    await migrate();
    await migrate();

    const creates = client.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => /CREATE TABLE/i.test(sql));
    expect(creates).toHaveLength(2);
    creates.forEach((sql) => expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS usage_counters/i));
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it('rolls back and releases the client on failure', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/CREATE TABLE/i.test(sql)) return Promise.reject(new Error('boom'));
        return Promise.resolve({ rowCount: 0 });
      }),
      release: jest.fn()
    };
    db.connect.mockResolvedValue(client);

    await expect(migrate()).rejects.toThrow('boom');
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('is mirrored in schema.sql and wired into migrate-all after subscriptions', () => {
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS usage_counters/);
    expect(schema).toMatch(/PRIMARY KEY \(user_id, day, kind\)/);

    const runner = fs.readFileSync(path.join(SCRIPTS_DIR, 'migrate-all.js'), 'utf8');
    const usageIndex = runner.indexOf('./migrate-usage-counters');
    const subscriptionsIndex = runner.indexOf('./migrate-subscriptions-integrity');
    expect(usageIndex).toBeGreaterThan(-1);
    expect(subscriptionsIndex).toBeGreaterThan(-1);
    expect(usageIndex).toBeGreaterThan(subscriptionsIndex);
  });
});
