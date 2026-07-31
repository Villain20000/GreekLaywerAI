// Phase 29: Subscriptions CRUD API.
//
// - GET  /api/subscriptions        current subscription (latest row)
// - GET  /api/subscriptions/history  full history
// - POST /api/subscriptions/cancel  cancel at period end (Stripe live mode
//                                   calls cancel_at_period_end=true)
// - POST /api/subscriptions/upgrade  { tier } → new Stripe checkout session

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const Stripe = require('stripe');
const stripeService = require('../services/stripeService');
const { ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');

// GET /api/subscriptions — current subscription
router.get('/', async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

// GET /api/subscriptions/history
router.get('/history', async (req, res) => {
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
    res.status(500).json({ error: error.message });
  }
});

// POST /api/subscriptions/cancel — cancel at period end
router.post('/cancel', async (req, res) => {
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
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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
    res.status(500).json({ error: error.message });
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
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
