const express = require('express');
const router = express.Router();
const stripeService = require('../services/stripeService');
const { rbacMiddleware, ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');

// 1-3: per-user caps on the Stripe-session-minting paths. The webhook is
// deliberately NOT rate-limited here (Stripe retries must not be throttled);
// idempotency for it lives in webhook.js via stripe_webhook_events.
const limiters = createApiRateLimiters();

// 2-5: server-owned plan catalog. The billing UI renders this instead of
// hardcoding tiers/prices/features. Mounted behind authMiddleware in
// index.js; this handler itself is read-only and needs no extra RBAC.
router.get('/plans', limiters.subscriptionRead, (req, res) => {
  res.json({ plans: stripeService.getPlans() });
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
      res.status(500).json({ error: error.message });
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
    if (stripeService.isMockMode()) {
      return res.status(403).json({ error: 'Customer portal is only available in live Stripe mode' });
    }
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
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
