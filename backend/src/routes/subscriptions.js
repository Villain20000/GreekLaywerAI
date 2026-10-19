// Phase 29: Subscriptions CRUD API.
//
// - GET  /api/subscriptions        current subscription (latest row)
// - GET  /api/subscriptions/history  full history
// - GET  /api/subscriptions/invoices paginated payment history
// - GET  /api/subscriptions/usage  quota usage for the caller (read-only)
// - POST /api/subscriptions/cancel  cancel at period end (Stripe live mode
//                                   calls cancel_at_period_end=true)
// - POST /api/subscriptions/reactivate  undo a scheduled cancellation
//                                   (live mode flips cancel_at_period_end
//                                   back to false, then restores status)
// - POST /api/subscriptions/upgrade  { tier } → new Stripe checkout session

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const Stripe = require('stripe');
const stripeService = require('../services/stripeService');
const quotaService = require('../services/quotaService');
const { logAudit } = require('../services/auditLog');
const { ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');
const { getSecret } = require('../config/secrets');

// 1-3: per-user caps (see rateLimiters.js).
const limiters = createApiRateLimiters();

const DEFAULT_INVOICE_LIMIT = 20;
const MAX_INVOICE_LIMIT = 100;

function parsePagination(query) {
  const requestedLimit = Number(query.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_INVOICE_LIMIT)
    : DEFAULT_INVOICE_LIMIT;
  const requestedOffset = Number(query.offset);
  const offset = Number.isInteger(requestedOffset) && requestedOffset > 0
    ? requestedOffset
    : 0;
  return { limit, offset };
}

// GET /api/subscriptions — current subscription
router.get('/', limiters.subscriptionRead, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at
       FROM subscriptions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [req.user.id]
    );
    const subscription = result.rows[0] || null;
    res.json({
      subscription,
      tier: req.user.subscription_tier || 'basic'
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/subscriptions/history
router.get('/history', limiters.subscriptionRead, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at
       FROM subscriptions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC`,
      [req.user.id]
    );
    res.json({ subscriptions: result.rows });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/subscriptions/invoices?limit=&offset= — paginated payment history.
// The invoices table is populated by the Stripe invoice webhooks; rows whose
// owner could not be resolved have user_id NULL and are never returned here.
router.get('/invoices', limiters.subscriptionRead, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM invoices WHERE user_id = $1`,
      [req.user.id]
    );
    const result = await db.query(
      `SELECT id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id,
              amount_due, amount_paid, currency, status, hosted_invoice_url, invoice_pdf,
              period_start, period_end, created_at, updated_at
       FROM invoices
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const totalRow = countResult.rows[0] || {};
    res.json({
      invoices: result.rows,
      total: Number(totalRow.total) || 0,
      limit,
      offset
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/subscriptions/usage — quota usage for the caller.
//
// Read-only projection of the counters quotaService.getUsage was written
// for: the daily AI-query consumption ("X of Y used") plus the uploaded
// -document count against the tier's document cap.
//
// Design constraints:
//   - READ-ONLY. It never calls consumeDailyQuota, so polling this
//     endpoint can never burn a unit of the caller's quota.
//   - The tier→limit mapping is NOT duplicated here. The limits come from
//     quotaService.getAiDailyLimit / getDocumentLimit — the very same
//     helpers quotaMiddleware uses to ENFORCE them — so the number we
//     show can never drift from the number that blocks a request.
//     getUsage's docstring ("the route can pass getAiDailyLimit(tier)")
//     describes exactly this call.
//   - The tier is req.user.subscription_tier, hydrated by authMiddleware
//     from the LIVE users row (not from a stale JWT claim).
//   - Admins are never quota-limited — the same convention as
//     quotaMiddleware.isAdmin() and tierMiddleware's `role === 'admin'`
//     bypass. Their limits are reported as null ("unlimited") while the
//     usage counters are still reported.
//   - Fails open: quotaService degrades to used: 0 when the DB is down,
//     so this endpoint answers 200 with zeros instead of 500-ing a page
//     that only wants to display a usage meter.
router.get('/usage', limiters.subscriptionRead, async (req, res) => {
  const tier = quotaService.normalizeTier(req.user.subscription_tier);
  const isAdmin = req.user.role === 'admin';

  // Admin ⇒ no limit (they are never enforced), mirroring quotaMiddleware.
  const aiLimit = isAdmin ? null : quotaService.getAiDailyLimit(tier);
  const documentLimit = isAdmin ? null : quotaService.getDocumentLimit(tier);

  try {
    const [ai, documents] = await Promise.all([
      quotaService.getUsage(req.user.id, quotaService.AI_KIND, { limit: aiLimit }),
      quotaService.getDocumentUsage(req.user.id, { limit: documentLimit })
    ]);

    res.json({
      tier,
      ai: {
        used: ai.used,
        limit: ai.limit,
        resetAt: ai.resetAt
      },
      documents: {
        used: documents.used,
        limit: documents.limit
      }
    });
  } catch (error) {
    // Belt-and-braces: quotaService already fails open, so an unexpected
    // throw must not turn a usage meter into a 500.
    console.error(`[QUOTA] usage endpoint failed for user ${req.user.id}: ${error.message}`);
    res.status(200).json({
      tier,
      ai: { used: 0, limit: aiLimit, resetAt: null },
      documents: { used: 0, limit: documentLimit }
    });
  }
});

// POST /api/subscriptions/cancel — cancel at period end
router.post('/cancel', limiters.subscriptionCancel, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, stripe_subscription_id, status
       FROM subscriptions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [req.user.id]
    );
    const sub = result.rows[0];
    if (!sub) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    if (stripeService.isConfigured() && sub.stripe_subscription_id) {
      const stripe = Stripe(getSecret('STRIPE_SECRET_KEY', 'sk_test_mock'));
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true
      });
    }

    await db.query(
      `UPDATE subscriptions SET status = $1 WHERE id = $2`,
      ['canceled_at_period_end', sub.id]
    );

    res.json({ ok: true, subscription: { id: sub.id, status: 'canceled_at_period_end' } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/subscriptions/reactivate — undo a cancellation scheduled at
// period end. Live Stripe mode calls `cancel_at_period_end: false` and mirrors
// the status Stripe reports; mock mode restores the local status directly.
// A subscription that has already fully ended cannot be reactivated.
router.post('/reactivate', limiters.subscriptionCancel, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, stripe_subscription_id, status
       FROM subscriptions
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [req.user.id]
    );
    const sub = result.rows[0];
    if (!sub) {
      return res.status(404).json({ error: 'No subscription found' });
    }
    if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      return res.status(409).json({ error: 'Subscription has already ended and cannot be reactivated' });
    }

    // Default: restore an at-period-end cancellation to active. Other local
    // states are left alone unless Stripe gives us a fresher status below.
    let status = sub.status === 'canceled_at_period_end' || !sub.status ? 'active' : sub.status;

    if (stripeService.isConfigured() && sub.stripe_subscription_id) {
      const updated = await stripeService.resumeSubscription({
        stripeSubscriptionId: sub.stripe_subscription_id
      });
      if (updated && updated.status) status = updated.status;
    }

    await db.query(
      `UPDATE subscriptions SET status = $1 WHERE id = $2`,
      [status, sub.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'subscription.reactivated',
      resourceType: 'subscription',
      resourceId: sub.stripe_subscription_id || sub.id,
      newValue: { status }
    });

    res.json({ ok: true, subscription: { id: sub.id, status } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// POST /api/subscriptions/upgrade — { tier } → checkout session
router.post(
  '/upgrade',
  validate([
    check('tier').isString().isIn(ALLOWED_TIERS).withMessage(`tier must be one of: ${ALLOWED_TIERS.join(', ')}`)
  ]),
  async (req, res) => {
    try {
      const session = await stripeService.createCheckoutSession({
        tier: req.body.tier,
        user: req.user
      });
      res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  }
);

module.exports = router;
