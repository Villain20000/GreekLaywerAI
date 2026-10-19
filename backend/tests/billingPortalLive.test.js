// 2-5: Billing portal + reactivate — live-mode coverage with a mocked
// Stripe client (no network). Mirrors the service-loading pattern in
// stripeService.test.js: the env key must be set before ../src/routes/billing
// (via ./app) pulls in stripeService.
process.env.NODE_ENV = 'test';

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID_BASIC',
  'STRIPE_PRICE_ID_PRO',
  'STRIPE_PRICE_ID_ENTERPRISE'
];
const envSnapshot = {};
for (const key of STRIPE_ENV_KEYS) envSnapshot[key] = process.env[key];
process.env.STRIPE_SECRET_KEY = 'sk_test_live_portal';

// jest.mock factories may only close over `mock`-prefixed identifiers.
const mockStripeClient = {
  billingPortal: { sessions: { create: jest.fn() } },
  subscriptions: { update: jest.fn() }
};
jest.mock('stripe', () => jest.fn(() => mockStripeClient));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const audit = require('../src/services/auditLog');
const stripeService = require('../src/services/stripeService');

const JWT_SECRET = 'nomos-super-secret-key-development';

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'pro',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1,
      verified_at: new Date('2026-01-01T00:00:00Z')
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

beforeEach(() => {
  db.query.mockReset();
  mockStripeClient.billingPortal.sessions.create.mockReset();
  mockStripeClient.subscriptions.update.mockReset();
  audit.logAudit.mockClear();
});

afterAll(() => {
  for (const key of STRIPE_ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe('stripeService portal (live mode)', () => {
  it('is configured for live mode in this file', () => {
    expect(stripeService.isConfigured()).toBe(true);
    expect(stripeService.isMockMode()).toBe(false);
  });

  it('creates a portal session with the latest customer id + return URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_123' }] });
    mockStripeClient.billingPortal.sessions.create.mockResolvedValue({
      id: 'bps_1',
      url: 'https://billing.stripe.com/p/session/test'
    });

    const session = await stripeService.createPortalSession({ user: { id: 2 } });

    expect(session).toEqual({
      id: 'bps_1',
      url: 'https://billing.stripe.com/p/session/test'
    });
    expect(db.query.mock.calls[0][0]).toMatch(/stripe_customer_id/);
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY created_at DESC/);
    expect(db.query.mock.calls[0][1]).toEqual([2]);
    expect(mockStripeClient.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_123',
      return_url: 'http://localhost:4200/billing'
    });
  });

  it('honours an explicit return URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_123' }] });
    mockStripeClient.billingPortal.sessions.create.mockResolvedValue({
      id: 'bps_2',
      url: 'https://billing.stripe.com/p/session/test2'
    });

    await stripeService.createPortalSession({
      user: { id: 2 },
      returnUrl: 'https://nomos.ai/subscriptions'
    });

    expect(mockStripeClient.billingPortal.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ return_url: 'https://nomos.ai/subscriptions' })
    );
  });

  it('throws a 404-ish error when no customer is stored', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await expect(stripeService.createPortalSession({ user: { id: 2 } }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(mockStripeClient.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/billing/portal (live mode)', () => {
  it('returns the portal URL', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_123' }] });
    mockStripeClient.billingPortal.sessions.create.mockResolvedValue({
      id: 'bps_3',
      url: 'https://billing.stripe.com/p/session/route'
    });

    const res = await request(app)
      .post('/api/billing/portal')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({
      url: 'https://billing.stripe.com/p/session/route',
      sessionId: 'bps_3'
    });
  });

  it('404s when the user has never checked out', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/billing/portal')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.error).toMatch(/no Stripe customer/i);
  });

  it('maps Stripe failures to a JSON 500', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_123' }] });
    mockStripeClient.billingPortal.sessions.create.mockRejectedValue(
      new Error('stripe down')
    );

    const res = await request(app)
      .post('/api/billing/portal')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(500);
    expect(res.body.error).toBe('stripe down');
  });
});

describe('stripeService resumeSubscription (live mode)', () => {
  it('flips cancel_at_period_end back to false', async () => {
    mockStripeClient.subscriptions.update.mockResolvedValue({ status: 'active' });

    const result = await stripeService.resumeSubscription({
      stripeSubscriptionId: 'sub_123'
    });

    expect(mockStripeClient.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: false
    });
    expect(result).toEqual({ status: 'active' });
  });

  it('is a local no-op without a Stripe subscription id', async () => {
    const result = await stripeService.resumeSubscription({ stripeSubscriptionId: null });
    expect(result).toBeNull();
    expect(mockStripeClient.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/subscriptions/reactivate (live mode)', () => {
  it('updates Stripe and stores the reported status', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, stripe_subscription_id: 'sub_123', status: 'canceled_at_period_end' }]
    });
    mockStripeClient.subscriptions.update.mockResolvedValue({ status: 'trialing' });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.subscription).toEqual({ id: 7, status: 'trialing' });
    expect(mockStripeClient.subscriptions.update).toHaveBeenCalledWith('sub_123', {
      cancel_at_period_end: false
    });

    const updateCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE subscriptions SET status/.test(sql)
    );
    expect(updateCall[1]).toEqual(['trialing', 7]);
    expect(audit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'subscription.reactivated' })
    );
  });

  it('passes Stripe errors through as JSON 500', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, stripe_subscription_id: 'sub_123', status: 'canceled_at_period_end' }]
    });
    mockStripeClient.subscriptions.update.mockRejectedValue(
      new Error('No such subscription')
    );

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(500);
    expect(res.body.error).toBe('No such subscription');
  });
});
