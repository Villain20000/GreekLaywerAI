// 1-4: Express middleware for daily AI quotas and uploaded-document caps.
//
// Ordering requirements (see routes/ai.js + routes/documents.js):
//   - AFTER authMiddleware: req.user.id/tier/role must be populated.
//   - AFTER requireTier/rbacMiddleware: a caller who is not entitled to the
//     feature should get 401/403 without burning quota.
//   - BEFORE multer on upload endpoints: an over-quota request must not buffer
//     a 25 MB body, let alone run extraction/embeddings.
//   - BEFORE enqueue/generation: the expensive work is what the quota bounds.
//
// Status codes:
//   - AI query overage       → 429 + Retry-After (seconds until UTC midnight)
//   - Document cap overage   → 403 (the cap is count-based; there is no
//     meaningful "retry after", deleting a document frees a slot)
//
// Admin bypass is consistent with requireTier/tierMiddleware: `role='admin'`
// is never quota-limited.
const quotaService = require('../services/quotaService');

const AI_LIMIT_ERROR = 'Daily AI query limit reached for your plan';
const DOCUMENT_LIMIT_ERROR = 'Document limit reached for your plan';

const KNOWN_TIERS = ['basic', 'pro', 'enterprise'];

function tierOf(req) {
  return quotaService.normalizeTier(req.user && req.user.subscription_tier);
}

function isAdmin(req) {
  return Boolean(req.user && req.user.role === 'admin');
}

/**
 * Whole seconds until `resetAt`, clamped to at least 1 (Retry-After: 0 is
 * legal but unhelpful). Exported for deterministic unit tests.
 */
function retryAfterSeconds(resetAt, now = new Date()) {
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return 60;
  const diffMs = target - now.getTime();
  return Math.max(1, Math.ceil(diffMs / 1000));
}

/**
 * Daily AI-query quota. Mounted on /query, /query/stream, /audio-query and
 * /multimodal — they all share the same `ai` counter, so a user cannot get
 * 20 + 60 + 120 attempts by rotating endpoints.
 */
async function enforceAiQuota(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  if (isAdmin(req)) {
    return next();
  }

  const tier = tierOf(req);
  const limit = quotaService.getAiDailyLimit(tier);

  let outcome;
  try {
    outcome = await quotaService.consumeDailyQuota(req.user.id, quotaService.AI_KIND, limit);
  } catch (error) {
    // quotaService already fails open; this is belt-and-braces so an
    // unexpected throw can never turn into a 500 on the AI surface.
    console.error(`[QUOTA] enforceAiQuota failed for user ${req.user.id}: ${error.message}`);
    return next();
  }

  if (!outcome.allowed) {
    res.setHeader('Retry-After', String(retryAfterSeconds(outcome.resetAt)));
    return res.status(429).json({
      error: AI_LIMIT_ERROR,
      limit: outcome.limit,
      used: outcome.used,
      tier,
      resetAt: outcome.resetAt
    });
  }

  req.quota = {
    kind: quotaService.AI_KIND,
    tier,
    used: outcome.used,
    limit: outcome.limit,
    resetAt: outcome.resetAt
  };
  return next();
}

/**
 * Uploaded-document cap. Counts existing `legal_documents` rows; there is no
 * daily reset. Unlimited tiers (enterprise) short-circuit without a COUNT.
 * DB errors fail open: an upload is allowed rather than 500-ing on a counter
 * hiccup (the per-minute upload limiter still bounds abuse).
 */
async function enforceDocumentCap(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  if (isAdmin(req)) {
    return next();
  }

  const tier = tierOf(req);
  const limit = quotaService.getDocumentLimit(tier);

  if (limit === null) {
    req.quota = {
      kind: 'documents',
      tier,
      used: null,
      limit: null,
      resetAt: null
    };
    return next();
  }

  let used;
  try {
    used = await quotaService.countUserDocuments(req.user.id);
  } catch (error) {
    console.error(`[QUOTA] enforceDocumentCap failed for user ${req.user.id}: ${error.message}`);
    return next();
  }

  if (used >= limit) {
    return res.status(403).json({
      error: DOCUMENT_LIMIT_ERROR,
      limit,
      used,
      tier
    });
  }

  req.quota = {
    kind: 'documents',
    tier,
    used,
    limit,
    resetAt: null
  };
  return next();
}

module.exports = {
  AI_LIMIT_ERROR,
  DOCUMENT_LIMIT_ERROR,
  retryAfterSeconds,
  tierOf,
  enforceAiQuota,
  enforceDocumentCap
};
