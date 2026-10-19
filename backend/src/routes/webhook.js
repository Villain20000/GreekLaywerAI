// Phase 29: Stripe webhook endpoint.
//
// IMPORTANT: this router must be mounted with a RAW body parser BEFORE the
// global express.json() (see index.js) — Stripe signature verification
// needs the exact bytes of the request body.
//
// 1-10: deliveries are idempotent via `stripe_webhook_events`
// (migrate-webhook-events.js). Stripe retries on any non-2xx AND redelivers
// at-least-once on network blips, so the same event id can arrive many
// times; claiming the id BEFORE dispatch guarantees the state change is
// applied exactly once.

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../config/db');
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

  // 1-10: claim the event id before dispatching. ON CONFLICT DO NOTHING
  // returns zero rows when this id was already processed, so a replay is
  // acknowledged (200) WITHOUT re-running the handler. A claim failure
  // (e.g. the DB is down) fails closed with 500 so Stripe retries later
  // instead of risking a double-applied state change now.
  try {
    const claimed = await db.query(
      `INSERT INTO stripe_webhook_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.id]
    );
    if (!claimed.rows.length) {
      console.log(
        `[STRIPE] Duplicate webhook ${event.id} (${event.type}) — already processed, acknowledging without reprocessing`
      );
      return res.json({ received: true });
    }
  } catch (err) {
    console.error('[STRIPE] Webhook idempotency claim failed:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  try {
    const result = await stripeService.handleWebhookEvent(event);
    if (result.handled) {
      console.log(`[STRIPE] Webhook ${event.type} handled`);
    } else {
      // Unhandled types are expected (Stripe emits far more events than we
      // subscribe to), but log them explicitly so ops can tell "ignored on
      // purpose" apart from "silently dropped".
      console.log(
        `[STRIPE] Unhandled webhook event type ${event.type}: ${result.reason || 'no handler'}`
      );
    }
    res.json({ received: true });
  } catch (err) {
    // Release the claim so Stripe's retry can reprocess the event — a
    // claimed-but-unapplied event would otherwise be acknowledged as a
    // duplicate on redelivery and the state change silently lost.
    try {
      await db.query('DELETE FROM stripe_webhook_events WHERE event_id = $1', [event.id]);
    } catch (cleanupErr) {
      console.error('[STRIPE] Failed to release webhook claim:', cleanupErr.message);
    }
    console.error('[STRIPE] Webhook handler error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
