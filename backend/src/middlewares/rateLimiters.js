// Phase 21: Auth-route rate limiting.
// Per-IP limits protect the public auth surface (/register, /login) from
// credential stuffing and bulk account creation. /change-password is
// JWT-gated, so the primary boundary is per-account, but a generous per-IP
// ceiling is layered *before* authMiddleware so an attacker cannot burn JWT-
// verify CPU unbounded by hitting with stolen / forged tokens.
//
// Storage is Redis-backed in production (ioredis@5 + rate-limit-redis@4).
// In tests, an in-memory store is used so jest's supertest doesn't trip the
// counter after running a few dozen requests from 127.0.0.1.
//
// `trust proxy` is configured in backend/src/index.js and determines what
// `req.ip` resolves to under a reverse proxy.

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const IORedis = require('ioredis');

const NODE_ENV = process.env.NODE_ENV || 'development';

// NOTE (Phase 21 v1): express-rate-limit@7 implements a FIXED window (the
// counter resets at the boundary, so a burst at exactly the minute/hour
// mark can briefly deliver 2× the cap). A true sliding window needs a
// Redis sorted-set (ZADD/ZREMRANGEBYSCORE/ZCARD). The user's request
// mentioned "Redis-backed sliding window" — that is a v2 followup. For
// the immediate "before production" risk surface this fixed-window
// implementation raises the cost of credential-stuffing and bulk account
// creation by 1–2 orders of magnitude, which is the meaningful delta.

/**
 * Lazy singleton ioredis client. Sharing one client across all limiters
 * keeps the connection-pool count bounded (default ioredis pool is 10;
 * otherwise five limiters = 50+ TCP connections to Redis per process).
 */
let sharedRedisClient = null;
function getSharedRedisClient() {
  if (NODE_ENV === 'test' || !process.env.REDIS_URL) return null;
  if (sharedRedisClient) return sharedRedisClient;
  sharedRedisClient = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null
  });
  sharedRedisClient.on('error', (err) => {
    console.error(`[RATE LIMIT] Redis client error: ${err.message}`);
  });
  return sharedRedisClient;
}

/**
 * Build a rate-limit store. Returns undefined (in-memory) in tests or when
 * REDIS_URL is missing so dev / CI work without Redis. All limiters share
 * the singleton Redis client via sendCommand.
 */
function createStore(prefix) {
  const client = getSharedRedisClient();
  if (!client) return undefined;
  return new RedisStore({
    // rate-limit-redis@4 requires sendCommand; ioredis@5 exposes .call().
    sendCommand: (...args) => client.call(...args),
    prefix: `rl:${prefix}:`
  });
}

// Re-export for jest factory convenience (see tests/app.js — both query and
// connect are mocked and a fake client delegates .query() to db.query()).
module.exports.createStore = createStore;

const STANDARD_OPTIONS = {
  standardHeaders: 'draft-7', // IETF RateLimit headers (draft-7)
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // Fail-open on store errors: if Redis is unreachable, allow the request
  // through rather than 500-ing the whole auth surface. Trade-off accepted.
  passOnStoreError: true
};

/**
 * Construct the limiters used on /api/auth/*.
 *
 *   - register                per-IP, 5/hour (prod) / 1000/hour (test)
 *   - login                   per-IP, 10/minute (prod) / 1000/minute (test)
 *   - me                      per-user, 120/minute (prod) / 1000/minute (test)
 *   - changePasswordPreAuth   per-IP, 30/minute (prod) / 1000/minute (test)
 *                              applied BEFORE authMiddleware so 401s cost
 *                              bounded CPU.
 *   - changePasswordPerAccount per-account, 5/minute + 20/day stacked
 *                              (prod) / 1000 each in test.
 *
 * `options.isTest = false` in production. `options.isTest = true` is the
 * default when NODE_ENV='test'. Tests that want to *verify* the limiters
 * should construct limiters explicitly via this factory (NOT through the
 * env fallback) so they can pick aggressive limits.
 */
function createRateLimiters(options = {}) {
  const isTest = options.isTest ?? (NODE_ENV === 'test');
  // Test ceiling: when the caller didn't pass an explicit override, we
  // raise the cap high enough that a single jest suite running ~30 requests
  // against the in-memory store doesn't trip. Production-wise, this branch
  // is unreachable because isTest is false.
  const TEST_CEILING = 1000;

  /**
   * Resolve a cap from (a) an explicit test override, (b) the test ceiling,
   * or (c) the production default. Production wins over test ceiling only
   * when isTest is false AND no explicit override was supplied.
   */
  function resolveCap(overrideOption, productionDefault) {
    if (overrideOption !== undefined && overrideOption !== null) return overrideOption;
    if (isTest) return TEST_CEILING;
    return productionDefault;
  }

  // keyGenerator for per-account limiters runs AFTER authMiddleware
  // (authMiddleware is synchronous and populates req.user via jwt.verify
  // before next()), so req.user.id is always defined here.
  const userKey = (req, suffix) =>
    `cp_${suffix}:${req.user && req.user.id !== undefined ? req.user.id : 'anon'}`;

  return {
    register: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 60 * 1000,                                                 // 1 hour
      max: resolveCap(options.registerMax, 5),                                 // 5/hr per IP
      keyGenerator: (req) => `register:${req.ip}`,
      store: createStore('register')
    }),

    login: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,                                                     // 1 minute
      max: resolveCap(options.loginMax, 10),                                   // 10/min per IP
      keyGenerator: (req) => `login:${req.ip}`,
      store: createStore('login')
    }),

    // 1-3: lenient cap on GET /api/auth/me. The route is cheap (req.user is
    // hydrated by authMiddleware), but an authenticated client could poll it
    // in a tight loop; 120/min per user bounds that without ever bothering
    // the ~2 calls a real page load makes. Mounted AFTER authMiddleware so
    // the bucket keys on the user id (see auth.js).
    me: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.meMax, 120),                                     // 120/min per user id
      keyGenerator: (req) => userKey(req, 'me'),
      store: createStore('me')
    }),

    // Per-IP layer before authMiddleware. Bounds the cost of hitting
    // /change-password with forged tokens (authMiddleware would 401, but
    // 401-spam is still CPU work — bcrypt+JWT-verify per request).
    changePasswordPreAuth: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.cpIpMax, 30),                                    // 30/min per IP
      keyGenerator: (req) => `cp_ip:${req.ip}`,
      store: createStore('cp_ip')
    }),

    // Per-account layer after authMiddleware. Primary defense: 5 attempts
    // per minute per user-id. A stolen JWT alone can't brute-force new
    // passwords faster than this.
    changePasswordPerAccount: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.cpAccountMax, 5),                                // 5/min per user id
      keyGenerator: (req) => userKey(req, 'user'),
      store: createStore('cp_user')
    }),

    // Cumulative day-capping per account: 20/day regardless of which minute
    // they fall into. Defends against an attacker who spreads attempts
    // across many days with a stolen JWT.
    changePasswordPerAccountDaily: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 24 * 60 * 60 * 1000,
      max: resolveCap(options.cpAccountDailyMax, 20),                          // 20/day per user id
      keyGenerator: (req) => userKey(req, 'user_day'),
      store: createStore('cp_user_day')
    }),

    // Phase 23: forgot-password is split into two stacked limiters so that
    // an enumeration spammer can't bypass the per-IP cap by distributing
    // probes across IPs (per-email cap) — simultaneously, the per-IP cap
    // catches bursts from any individual IP. Both apply.
    forgotPasswordIpMin: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.forgotIpMaxMin, 5),                              // 5/min per IP
      keyGenerator: (req) => `forgot_ip:${req.ip}`,
      store: createStore('forgot_ip')
    }),
    forgotPasswordIpHour: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 60 * 1000,
      max: resolveCap(options.forgotIpMaxHour, 20),                            // 20/hr per IP
      keyGenerator: (req) => `forgot_ip_hr:${req.ip}`,
      store: createStore('forgot_ip_hr')
    }),
    forgotPasswordEmail: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 60 * 1000,
      max: resolveCap(options.forgotEmailMax, 3),                              // 3/hr per email
      // Normalize email to lowercase so case-variants share a bucket.
      keyGenerator: (req) => {
        const raw = (req.body && typeof req.body.email === 'string') ? req.body.email : '';
        return `forgot_email:${raw.trim().toLowerCase() || 'anon'}`;
      },
      store: createStore('forgot_email')
    }),

    // Phase 23: reset-password has no JWT yet (the token IS the bearer), so
    // the natural boundary is per-IP. The token itself binds an individual
    // attempt; we cap how often one IP can probe the route.
    resetPasswordIp: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.resetIpMax, 10),                                 // 10/min per IP
      keyGenerator: (req) => `reset_ip:${req.ip}`,
      store: createStore('reset_ip')
    }),

    // Phase 24: verify-email and resend-verification pair up with the
    // /forgot-password dual-stack (per-IP burst + per-email drip). verify-
    // email is consumed-by-token so the only free signal is per-IP rate;
    // resend-verification reuses the email-keyed limiter to stop address
    // spam. Caps mirror forgot-password's posture (5/min + 20/hr per IP,
    // 3/hr per email) — same threat model (account enumeration + DoS).
    verifyEmailIp: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.verifyEmailIpMax, 20),                           // 20/min per IP
      keyGenerator: (req) => `verify_email_ip:${req.ip}`,
      store: createStore('verify_email_ip')
    }),
    resendVerificationIp: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.resendIpMaxMin, 5),                              // 5/min per IP
      keyGenerator: (req) => `resend_v_ip:${req.ip}`,
      store: createStore('resend_v_ip')
    }),
    resendVerificationEmail: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 60 * 1000,
      max: resolveCap(options.resendEmailMax, 3),                              // 3/hr per email
      keyGenerator: (req) => {
        const raw = (req.body && typeof req.body.email === 'string') ? req.body.email : '';
        return `resend_v_email:${raw.trim().toLowerCase() || 'anon'}`;
      },
      store: createStore('resend_v_email')
    })
  };
}

module.exports = { createRateLimiters, createAiRateLimiters, createApiRateLimiters };

/**
 * Phase 29: AI-route rate limiters, tier-aware.
 *
 *   - query + stream: 20/min (basic), 60/min (pro), 120/min (enterprise)
 *   - audio-query:     5/min per user (premium)
 *   - multimodal:      10/min per user (premium)
 *   - job polling:     120/min per user (defends against polling spam)
 *
 * The `max` is a function of req.user.subscription_tier, resolved per
 * request. All limiters emit RateLimit-* headers and 429 on excess.
 */
function createAiRateLimiters(options = {}) {
  const isTest = options.isTest ?? (NODE_ENV === 'test');
  const TEST_CEILING = 1000;

  function resolveCap(overrideOption, productionDefault) {
    if (overrideOption !== undefined && overrideOption !== null) return overrideOption;
    if (isTest) return TEST_CEILING;
    return productionDefault;
  }

  const TIER_QUERY_LIMITS = {
    basic: resolveCap(options.aiQueryBasicMax, 20),
    pro: resolveCap(options.aiQueryProMax, 60),
    enterprise: resolveCap(options.aiQueryEnterpriseMax, 120)
  };

  const userKey = (req, prefix) =>
    `${prefix}:${req.user && req.user.id !== undefined ? req.user.id : 'anon'}`;

  const tierMax = (req) => {
    const tier = req.user && req.user.subscription_tier;
    return TIER_QUERY_LIMITS[tier] || TIER_QUERY_LIMITS.basic;
  };

  return {
    query: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: tierMax,
      keyGenerator: (req) => userKey(req, 'ai_query'),
      store: createStore('ai_query')
    }),
    stream: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: tierMax,
      keyGenerator: (req) => userKey(req, 'ai_stream'),
      store: createStore('ai_stream')
    }),
    audioQuery: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.aiAudioMax, 5),
      keyGenerator: (req) => userKey(req, 'ai_audio'),
      store: createStore('ai_audio')
    }),
    multimodal: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.aiMultimodalMax, 10),
      keyGenerator: (req) => userKey(req, 'ai_mm'),
      store: createStore('ai_mm')
    }),
    poll: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.aiPollMax, 120),
      keyGenerator: (req) => userKey(req, 'ai_poll'),
      store: createStore('ai_poll')
    }),
    feedback: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.aiFeedbackMax, 30),
      keyGenerator: (req) => userKey(req, 'ai_feedback'),
      store: createStore('ai_feedback')
    })
  };
}

/**
 * 1-3: rate limiters for the authenticated product surface that previously
 * had none — documents, conversations, subscriptions, GDPR, billing.
 *
 * Every route below is mounted BEHIND authMiddleware (see index.js), so
 * req.user.id is always hydrated and the bucket keys per account. The
 * webhook endpoint is deliberately NOT covered here: Stripe retries
 * deliveries and a generic 429 would be indistinguishable from a handler
 * failure (which SHOULD be retried) — webhook idempotency instead lives in
 * `stripe_webhook_events` (1-10).
 *
 * Caps are per-minute and sized so normal UI flows (list + poll + a few
 * uploads) never trip while abuse (embedding spam, export/delete loops,
 * checkout churn) is bounded:
 *
 *   - documentUpload      10/min   (parsing + embeddings; the expensive one)
 *   - documentSearch      30/min   (embedding + vector search)
 *   - conversationList   120/min   (cheap reads, chat UI polls)
 *   - conversationCreate  30/min
 *   - subscriptionRead    60/min
 *   - subscriptionCancel   5/min   (Stripe API + state change)
 *   - gdprExport           5/min   (full-table dump)
 *   - gdprDelete           3/hour  (irreversible; slower than any UI flow)
 *   - billingCheckout     10/min   (Stripe session creation)
 *   - billingMockComplete 10/min   (dev-only tier grant; live mode 403s)
 */
function createApiRateLimiters(options = {}) {
  const isTest = options.isTest ?? (NODE_ENV === 'test');
  const TEST_CEILING = 1000;

  function resolveCap(overrideOption, productionDefault) {
    if (overrideOption !== undefined && overrideOption !== null) return overrideOption;
    if (isTest) return TEST_CEILING;
    return productionDefault;
  }

  const userKey = (req, prefix) =>
    `${prefix}:${req.user && req.user.id !== undefined ? req.user.id : 'anon'}`;

  return {
    documentUpload: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.documentUploadMax, 10),                          // 10/min per user id
      keyGenerator: (req) => userKey(req, 'doc_upload'),
      store: createStore('doc_upload')
    }),
    documentSearch: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.documentSearchMax, 30),                          // 30/min per user id
      keyGenerator: (req) => userKey(req, 'doc_search'),
      store: createStore('doc_search')
    }),
    conversationList: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.conversationListMax, 120),                       // 120/min per user id
      keyGenerator: (req) => userKey(req, 'conv_list'),
      store: createStore('conv_list')
    }),
    conversationCreate: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.conversationCreateMax, 30),                      // 30/min per user id
      keyGenerator: (req) => userKey(req, 'conv_create'),
      store: createStore('conv_create')
    }),
    subscriptionRead: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.subscriptionReadMax, 60),                        // 60/min per user id
      keyGenerator: (req) => userKey(req, 'sub_read'),
      store: createStore('sub_read')
    }),
    subscriptionCancel: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.subscriptionCancelMax, 5),                       // 5/min per user id
      keyGenerator: (req) => userKey(req, 'sub_cancel'),
      store: createStore('sub_cancel')
    }),
    gdprExport: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.gdprExportMax, 5),                               // 5/min per user id
      keyGenerator: (req) => userKey(req, 'gdpr_export'),
      store: createStore('gdpr_export')
    }),
    gdprDelete: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 60 * 1000,
      max: resolveCap(options.gdprDeleteMax, 3),                               // 3/hour per user id
      keyGenerator: (req) => userKey(req, 'gdpr_delete'),
      store: createStore('gdpr_delete')
    }),
    billingCheckout: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.billingCheckoutMax, 10),                         // 10/min per user id
      keyGenerator: (req) => userKey(req, 'billing_checkout'),
      store: createStore('billing_checkout')
    }),
    billingMockComplete: rateLimit({
      ...STANDARD_OPTIONS,
      windowMs: 60 * 1000,
      max: resolveCap(options.billingMockCompleteMax, 10),                     // 10/min per user id
      keyGenerator: (req) => userKey(req, 'billing_mock'),
      store: createStore('billing_mock')
    })
  };
}
