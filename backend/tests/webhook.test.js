// P0-1: Stripe webhook reachability + 1-10: webhook idempotency.
//
// The webhook must answer Stripe's tokenless POSTs directly — it is mounted
// BEFORE the authMiddleware-guarded `/api/billing` mount (see index.js) and
// runs its OWN signature verification. These tests build the same mount
// shape as index.js and assert the webhook never 401s for a missing Bearer
// token (the pre-fix behavior, caused by mount ordering).
//
// 1-10: delivery is idempotent via `stripe_webhook_events`. The router
// claims `event.id` with INSERT … ON CONFLICT DO NOTHING RETURNING before
// dispatch; tests therefore mock ../src/config/db and queue the claim rows
// (one row for a fresh event, zero rows for a replay).
process.env.NODE_ENV = 'test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

jest.mock('../src/services/stripeService', () => ({
  handleWebhookEvent: jest.fn().mockResolvedValue({ handled: true, reason: undefined }),
  isConfigured: jest.fn().mockReturnValue(false),
  isMockMode: jest.fn().mockReturnValue(true),
  createCheckoutSession: jest.fn(),
  completeMockCheckout: jest.fn(),
  upsertSubscription: jest.fn()
}));

// 1-10: the router now claims each event id in `stripe_webhook_events`
// before dispatching. The default mock resolves to zero rows (as if a query
// ran without a queued Once response) — tests queue the claim explicitly.
jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const Stripe = require('stripe');
const db = require('../src/config/db');
const webhookRoutes = require('../src/routes/webhook');
const stripeService = require('../src/services/stripeService');

const SECRET = 'whsec_test_secret';
const stripe = Stripe('sk_test_mock');

function buildApp() {
  const app = express();
  // Mirror index.js: raw body parser on the webhook path BEFORE the route.
  app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/billing/webhook', webhookRoutes);
  return app;
}

function eventPayload(id, type, object = {}) {
  return JSON.stringify({ id, type, data: { object } });
}

function signedPost(app, payload) {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return request(app)
    .post('/api/billing/webhook')
    .set('stripe-signature', header)
    .set('Content-Type', 'application/json')
    .send(payload);
}

/** Queue the idempotency claim for a FRESH event id (one returned row). */
function queueFreshClaim(eventId) {
  db.query.mockResolvedValueOnce({ rows: [{ event_id: eventId }] });
}

describe('Stripe webhook (/api/billing/webhook)', () => {
  beforeEach(() => {
    stripeService.handleWebhookEvent.mockClear();
    stripeService.handleWebhookEvent.mockResolvedValue({ handled: true, reason: undefined });
    db.query.mockReset();
    // Default: a claim that returns no rows (duplicate) and any follow-up
    // DELETE resolves cleanly. Tests override per-case with Once queues.
    db.query.mockResolvedValue({ rows: [] });
  });

  it('does not require a Bearer token — reaches its own signature guard', async () => {
    const payload = eventPayload('evt_1', 'checkout.session.completed');

    const res = await request(buildApp())
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .send(payload);

    // 400 from the webhook's own missing-signature guard, NOT 401 from
    // authMiddleware (the mount-order regression this test locks in).
    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/Missing Stripe-Signature/);
    // Rejected before the idempotency claim — unverified payloads must never
    // write to the events table.
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 400', async () => {
    const payload = eventPayload('evt_2', 'checkout.session.completed');

    const res = await request(buildApp())
      .post('/api/billing/webhook')
      .set('stripe-signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/signature verification failed/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('accepts a valid signed payload and dispatches to the service', async () => {
    const payload = eventPayload('evt_3', 'checkout.session.completed', { id: 'cs_1' });
    queueFreshClaim('evt_3');

    const res = await signedPost(buildApp(), payload);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ received: true });
    expect(stripeService.handleWebhookEvent).toHaveBeenCalledTimes(1);
    const event = stripeService.handleWebhookEvent.mock.calls[0][0];
    expect(event.type).toBe('checkout.session.completed');

    // The claim must run against the events table with the event id, and
    // must be the conflict-silent form so replays don't raise.
    const claimCall = db.query.mock.calls[0];
    expect(claimCall[0]).toMatch(/INSERT INTO stripe_webhook_events/i);
    expect(claimCall[0]).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/i);
    expect(claimCall[1]).toEqual(['evt_3']);
  });

  it('processes the first delivery but acks a replay of the same event id without reprocessing', async () => {
    const payload = eventPayload('evt_dup', 'customer.subscription.deleted', { id: 'sub_1' });

    // First delivery: claim succeeds (row returned) → handler runs.
    queueFreshClaim('evt_dup');
    const first = await signedPost(buildApp(), payload);
    expect(first.statusCode).toEqual(200);
    expect(first.body).toEqual({ received: true });
    expect(stripeService.handleWebhookEvent).toHaveBeenCalledTimes(1);

    // Second delivery of the SAME id: the INSERT conflicts → zero rows →
    // 200 {received:true} WITHOUT calling the handler again.
    const second = await signedPost(buildApp(), payload);
    expect(second.statusCode).toEqual(200);
    expect(second.body).toEqual({ received: true });
    expect(stripeService.handleWebhookEvent).toHaveBeenCalledTimes(1);

    // Both deliveries attempted the same claim for the same event id.
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][0]).toMatch(/INSERT INTO stripe_webhook_events/i);
    expect(db.query.mock.calls[1][1]).toEqual(['evt_dup']);
  });

  it('logs unhandled event types explicitly and still acks with 200', async () => {
    const payload = eventPayload('evt_unhandled', 'customer.created', { id: 'cus_1' });
    queueFreshClaim('evt_unhandled');
    stripeService.handleWebhookEvent.mockResolvedValueOnce({
      handled: false,
      reason: 'unhandled event type customer.created'
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await signedPost(buildApp(), payload);
      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ received: true });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unhandled webhook event type customer.created')
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it('releases the idempotency claim when the handler fails so Stripe can retry', async () => {
    const payload = eventPayload('evt_err', 'checkout.session.completed', { id: 'cs_err' });
    queueFreshClaim('evt_err');
    stripeService.handleWebhookEvent.mockRejectedValueOnce(new Error('handler boom'));

    const res = await signedPost(buildApp(), payload);
    expect(res.statusCode).toEqual(500);

    // Claim row must be deleted — otherwise the redelivery would be acked
    // as a duplicate and the state change would be lost forever.
    const cleanupCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /DELETE FROM stripe_webhook_events/i.test(sql)
    );
    expect(cleanupCall).toBeDefined();
    expect(cleanupCall[1]).toEqual(['evt_err']);

    // Retry after the release: fresh claim + successful handler → 200.
    queueFreshClaim('evt_err');
    stripeService.handleWebhookEvent.mockResolvedValueOnce({ handled: true });
    const retry = await signedPost(buildApp(), payload);
    expect(retry.statusCode).toEqual(200);
    expect(stripeService.handleWebhookEvent).toHaveBeenCalledTimes(2);
  });

  it('fails closed with 500 when the idempotency claim itself errors', async () => {
    const payload = eventPayload('evt_claim_fail', 'checkout.session.completed', { id: 'cs_x' });
    db.query.mockRejectedValueOnce(new Error('db down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await signedPost(buildApp(), payload);
      expect(res.statusCode).toEqual(500);
      // No dispatch happened — a retryable 500 is safer than a possible
      // double-applied state change.
      expect(stripeService.handleWebhookEvent).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('fails closed with 400 when STRIPE_WEBHOOK_SECRET is not configured', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      let freshApp;
      jest.isolateModules(() => {
        const freshRoutes = require('../src/routes/webhook');
        freshApp = express();
        freshApp.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
        freshApp.use('/api/billing/webhook', freshRoutes);
      });

      const res = await request(freshApp)
        .post('/api/billing/webhook')
        .set('stripe-signature', 't=1,v1=whatever')
        .set('Content-Type', 'application/json')
        .send(eventPayload('evt_x', 'x'));

      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toMatch(/secret not configured/i);
      expect(stripeService.handleWebhookEvent).not.toHaveBeenCalled();
      expect(db.query).not.toHaveBeenCalled();
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
