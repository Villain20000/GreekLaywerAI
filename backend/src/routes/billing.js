const express = require('express');
const router = express.Router();
const stripeService = require('../services/stripeService');
const cacheService = require('../services/cacheService');
const { rbacMiddleware, ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');

// 1-3: per-user caps on the Stripe-session-minting paths. The webhook is
// deliberately NOT rate-limited here (Stripe retries must not be throttled);
// idempotency for it lives in webhook.js via stripe_webhook_events.
const limiters = createApiRateLimiters();

const PLANS_CACHE_KEY = 'billing:plans';
const PLANS_CACHE_TTL_SECONDS = (() => {
  const parsed = Number(process.env.PLANS_CACHE_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 3600;
})();

// 2-5: server-owned plan catalog. The billing UI renders this instead of
// hardcoding tiers/prices/features. Mounted behind authMiddleware in
// index.js; this handler itself is read-only and needs no extra RBAC.
// The catalog is identical for every caller, so it is safe to cache.
router.get('/plans', limiters.subscriptionRead, async (req, res) => {
  const cached = await cacheService.getJson(PLANS_CACHE_KEY);
  if (Array.isArray(cached) && cached.length > 0) {
    return res.json({ plans: cached });
  }

  const plans = stripeService.getPlans();
  await cacheService.setJson(PLANS_CACHE_KEY, plans, PLANS_CACHE_TTL_SECONDS);
  return res.json({ plans });
});

// Checkout endpoint. Open to user|admin|enterprise so a free-tier 'user'
// can still pay to upgrade (otherwise the billing catch-22 would block
// upgrades entirely).
router.post(
  '/create-checkout-session',
  limiters.billingCheckout,
  validate([
    check('tier')
      .isString()
      .isIn(ALLOWED_TIERS)
      .withMessage(`tier must be one of: ${ALLOWED_TIERS.join(', ')}`)
  ]),
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const { tier } = req.body;
      const session = await stripeService.createCheckoutSession({
        tier,
        user: req.user
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
);

// 2-5: Stripe Billing Portal session. Live mode only — mock mode 403s with
// a clear JSON body (mirrors the /mock-complete live-mode guard, inverted).
// Users without a stored Stripe customer get a 404 instead of a Stripe error.
router.post(
  '/portal',
  limiters.billingCheckout,
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    try {
      const session = await stripeService.createPortalSession({ user: req.user });
      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
);

// Dev/mock checkout completion. The mock createCheckoutSession URL points at
// `${APP_BASE_URL}/chat?mock_payment=success&tier=…`; the frontend calls this
// route on return to actually apply the paid tier — the exact same
// upsert + tier-sync path a real `checkout.session.completed` webhook uses.
// Live Stripe mode always 403s: real upgrades flow through the webhook.
router.post(
  '/mock-complete',
  limiters.billingMockComplete,
  validate([
    check('tier')
      .isString()
      .isIn(ALLOWED_TIERS)
      .withMessage(`tier must be one of: ${ALLOWED_TIERS.join(', ')}`)
  ]),
  rbacMiddleware(['user', 'admin', 'enterprise']),
  async (req, res) => {
    if (!stripeService.isMockMode()) {
      return res.status(403).json({ error: 'Mock checkout is only available in mock mode' });
    }
    try {
      const result = await stripeService.completeMockCheckout({
        user: req.user,
        tier: req.body.tier
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
);

module.exports = router;
