// Phase 29: Stripe webhook endpoint.
//
// IMPORTANT: this router must be mounted with a RAW body parser BEFORE the
// global express.json() (see index.js) — Stripe signature verification
// needs the exact bytes of the request body.

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripeService = require('../services/stripeService');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

router.post('/', async (req, res) => {
  if (!WEBHOOK_SECRET) {
    // Fail closed: without a signing secret we cannot trust any payload.
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  }

  let event;
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_mock');
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[STRIPE] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  try {
    const result = await stripeService.handleWebhookEvent(event);
    console.log(
      `[STRIPE] Webhook ${event.type} handled=${result.handled} ${result.reason || ''}`
    );
    res.json({ received: true });
  } catch (err) {
    console.error('[STRIPE] Webhook handler error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
