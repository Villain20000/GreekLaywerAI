// 1-4: Daily tier quotas + per-tier document caps.
//
// Storage: Postgres `usage_counters(user_id, day, kind, count)` — deliberately
// NOT Redis. The counter is one atomic UPSERT per request, so it is correct
// across restarts and does not silently reset when the cache is flushed. The
// primary key (user_id, day, kind) makes the increment race-free without a
// transaction: concurrent requests serialize on the row lock and each sees a
// monotonically increasing value.
//
// Day boundary: UTC. `day` is a calendar date derived from `now.toISOString()`
// and `resetAt` is the next UTC midnight. Using UTC (rather than the server's
// local timezone) keeps all instances consistent and makes the reset instant
// easy to explain to clients. A user in Athens sees the quota reset at 02:00
// or 03:00 local time depending on DST; this is intentional and documented in
// the 429 response via `resetAt`.
//
// Fail-open policy: if the counter query errors (DB blip, pool exhaustion,
// migration not yet applied), the request is ALLOWED. Quotas are a billing
// fairness control, not a security boundary (the per-minute rate limiters
// still bound abuse). Locking a paying user out because a counter read
// hiccupped is the worse failure mode; the error is logged with a `[QUOTA]`
// prefix so operators can alert on it.
const db = require('../config/db');

const AI_KIND = 'ai';

// Production defaults, matching the billing UI (frontend billing.component.ts).
const DEFAULT_AI_LIMITS = Object.freeze({ basic: 20, pro: 60, enterprise: 120 });
// `null` means unlimited (enterprise documents).
const DEFAULT_DOCUMENT_LIMITS = Object.freeze({ basic: 10, pro: 50, enterprise: null });

// Same idea as rateLimiters.TEST_CEILING: keep the existing test suite from
// tripping real quotas while still letting a test opt into enforcement by
// setting the specific env var (e.g. QUOTA_AI_BASIC=2). Values are read on
// every call (`createQuotaLimits()` below), so a test can set the env var
// after requiring this module and still get the low limit — no re-require
// needed. Explicit env values always win over the test ceiling.
const TEST_CEILING = 100000;

const ENV_KEYS = Object.freeze({
  ai: Object.freeze({
    basic: 'QUOTA_AI_BASIC',
    pro: 'QUOTA_AI_PRO',
    enterprise: 'QUOTA_AI_ENTERPRISE'
  }),
  documents: Object.freeze({
    basic: 'QUOTA_DOCS_BASIC',
    pro: 'QUOTA_DOCS_PRO',
    enterprise: 'QUOTA_DOCS_ENTERPRISE'
  })
});

/**
 * Parse a limit value. Accepts numbers and env strings; `unlimited` (also
 * `inf`, `infinity`, `none`, `null`) maps to `null`, which callers treat as
 * "no cap". Invalid/negative values fall back to the production default so a
 * typo can never accidentally block everyone (e.g. QUOTA_AI_BASIC=abc should
 * not become 0).
 */
function normalizeLimit(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'number') {
    if (raw === Infinity) return null;
    if (!Number.isFinite(raw) || raw < 0) return fallback;
    return Math.floor(raw);
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return fallback;
  if (['unlimited', 'infinity', 'inf', 'none', 'null'].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeTier(tier) {
  const value = typeof tier === 'string' ? tier.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(DEFAULT_AI_LIMITS, value) ? value : 'basic';
}

/**
 * Build the effective limit table.
 *
 * Resolution order per limit:
 *   1. explicit `options.*` override (tests / dependency injection),
 *   2. explicit `process.env.QUOTA_*` value,
 *   3. TEST_CEILING when NODE_ENV=test,
 *   4. production default.
 *
 * `options.isTest` defaults to NODE_ENV==='test' (same contract as
 * createRateLimiters/createAiRateLimiters). Tests that need the real tier
 * numbers pass `{ isTest: false }`.
 */
function createQuotaLimits(options = {}) {
  const isTest = options.isTest ?? ((process.env.NODE_ENV || 'development') === 'test');

  function resolveLimit(envKey, override, productionDefault) {
    if (override !== undefined && override !== null) return normalizeLimit(override, productionDefault);
    const raw = process.env[envKey];
    if (raw !== undefined && String(raw).trim() !== '') return normalizeLimit(raw, productionDefault);
    if (isTest) return TEST_CEILING;
    return productionDefault;
  }

  return {
    ai: {
      basic: resolveLimit(ENV_KEYS.ai.basic, options.aiBasic, DEFAULT_AI_LIMITS.basic),
      pro: resolveLimit(ENV_KEYS.ai.pro, options.aiPro, DEFAULT_AI_LIMITS.pro),
      enterprise: resolveLimit(ENV_KEYS.ai.enterprise, options.aiEnterprise, DEFAULT_AI_LIMITS.enterprise)
    },
    documents: {
      basic: resolveLimit(ENV_KEYS.documents.basic, options.documentsBasic, DEFAULT_DOCUMENT_LIMITS.basic),
      pro: resolveLimit(ENV_KEYS.documents.pro, options.documentsPro, DEFAULT_DOCUMENT_LIMITS.pro),
      enterprise: resolveLimit(
        ENV_KEYS.documents.enterprise,
        options.documentsEnterprise,
        DEFAULT_DOCUMENT_LIMITS.enterprise
      )
    }
  };
}

/** Effective daily AI-query cap for a tier. Read lazily (env may change). */
function getAiDailyLimit(tier) {
  return createQuotaLimits().ai[normalizeTier(tier)];
}

/** Effective uploaded-document cap for a tier. `null` means unlimited. */
function getDocumentLimit(tier) {
  return createQuotaLimits().documents[normalizeTier(tier)];
}

/** Full effective limit table (useful for a future usage/billing endpoint). */
function getQuotaLimits() {
  return createQuotaLimits();
}

/** UTC calendar day (`YYYY-MM-DD`) for a Date. */
function utcDayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Next UTC midnight strictly after `now`. */
function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function toCount(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Atomically consume one unit of a daily quota.
 *
 * @returns {Promise<{allowed: boolean, used: number, limit: number|null, resetAt: string}>}
 *   `used` is the counter AFTER this request, `limit` is null when unlimited,
 *   `resetAt` is the next UTC midnight as an ISO-8601 string.
 *
 * The single UPSERT is the whole read-modify-write: it cannot lose an update
 * under concurrency. It intentionally keeps incrementing past the limit so
 * the response reports the true attempt count; the caller decides whether
 * count > limit means "deny".
 */
async function consumeDailyQuota(userId, kind, limit, { now = new Date() } = {}) {
  const effectiveLimit = normalizeLimit(limit, null);
  const day = utcDayKey(now);
  const resetAt = nextUtcMidnight(now).toISOString();

  try {
    const result = await db.query(
      `INSERT INTO usage_counters (user_id, day, kind, count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, day, kind)
       DO UPDATE SET count = usage_counters.count + 1
       RETURNING count`,
      [userId, day, kind]
    );
    const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
    if (!row) {
      // INSERT ... RETURNING always yields a row against Postgres. An empty
      // result means the seam is mocked/misconfigured; fail open rather than
      // treating it as "used 0" silently.
      throw new Error('usage counter upsert returned no row');
    }
    const used = toCount(row.count);
    return {
      allowed: effectiveLimit === null || used <= effectiveLimit,
      used,
      limit: effectiveLimit,
      resetAt
    };
  } catch (error) {
    console.error(
      `[QUOTA] consumeDailyQuota failed for user ${userId} kind ${kind}: ${error.message}`
    );
    return { allowed: true, used: 0, limit: effectiveLimit, resetAt };
  }
}

/**
 * Read-only usage for a future `GET /api/subscriptions`/usage endpoint.
 * `limit` is optional because this service does not know the caller's tier;
 * the route can pass `getAiDailyLimit(tier)`. A read failure degrades to
 * `used: 0` (console-facing only, never blocks anything).
 */
async function getUsage(userId, kind, { now = new Date(), limit = null } = {}) {
  const effectiveLimit = normalizeLimit(limit, null);
  const day = utcDayKey(now);
  const resetAt = nextUtcMidnight(now).toISOString();

  try {
    const result = await db.query(
      `SELECT count FROM usage_counters WHERE user_id = $1 AND day = $2 AND kind = $3`,
      [userId, day, kind]
    );
    const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
    return {
      used: row ? toCount(row.count) : 0,
      limit: effectiveLimit,
      resetAt
    };
  } catch (error) {
    console.error(`[QUOTA] getUsage failed for user ${userId} kind ${kind}: ${error.message}`);
    return { used: 0, limit: effectiveLimit, resetAt };
  }
}

/**
 * Read-only document usage for the usage endpoint.
 *
 * The document cap is NOT backed by `usage_counters` (that table only
 * holds daily counters — 'ai' today); it counts rows in
 * `legal_documents` instead, exactly like enforceDocumentCap does. The
 * number reported here therefore matches the number that blocks an
 * upload — they read the same source.
 *
 * There is no daily reset for documents, hence `resetAt: null`.
 *
 * Fail-open, same rationale as getUsage: a DB blip degrades to
 * `used: 0` instead of throwing, because usage is informational and must
 * never break the caller's page.
 */
async function getDocumentUsage(userId, { limit = null } = {}) {
  const effectiveLimit = normalizeLimit(limit, null);
  try {
    const used = await countUserDocuments(userId);
    return { used, limit: effectiveLimit, resetAt: null };
  } catch (error) {
    console.error(`[QUOTA] getDocumentUsage failed for user ${userId}: ${error.message}`);
    return { used: 0, limit: effectiveLimit, resetAt: null };
  }
}

/**
 * Count the user's uploaded documents. The table is `legal_documents` (the
 * plan's `documents` shorthand); chunks live in `legal_document_chunks` and
 * cascade-delete with the parent, so one row == one upload.
 *
 * Throws on DB errors; the document middleware deliberately catches and
 * fails open (same rationale as consumeDailyQuota).
 */
async function countUserDocuments(userId) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM legal_documents WHERE user_id = $1`,
    [userId]
  );
  const row = result && Array.isArray(result.rows) ? result.rows[0] : null;
  return row ? toCount(row.count) : 0;
}

module.exports = {
  AI_KIND,
  TEST_CEILING,
  DEFAULT_AI_LIMITS,
  DEFAULT_DOCUMENT_LIMITS,
  ENV_KEYS,
  createQuotaLimits,
  getAiDailyLimit,
  getDocumentLimit,
  getQuotaLimits,
  normalizeLimit,
  normalizeTier,
  utcDayKey,
  nextUtcMidnight,
  consumeDailyQuota,
  getUsage,
  getDocumentUsage,
  countUserDocuments
};
