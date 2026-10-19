// 2-5: Billing plans + portal + reactivate — mock-mode API coverage.
//
// Pins:
//   - GET /api/billing/plans returns the server-owned catalog;
//   - POST /api/billing/portal is live-mode only (clear 403 JSON in mock);
//   - POST /api/subscriptions/reactivate restores a scheduled cancellation.
process.env.NODE_ENV = 'test';

const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_ID_BASIC',
  'STRIPE_PRICE_ID_PRO',
  'STRIPE_PRICE_ID_ENTERPRISE'
];
const envSnapshot = {};
for (const key of STRIPE_ENV_KEYS) envSnapshot[key] = process.env[key];
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';

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
      subscription_tier: overrides.subscription_tier ?? 'basic',
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

afterAll(() => {
  for (const key of STRIPE_ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe('Billing plans (GET /api/billing/plans)', () => {
  afterEach(() => db.query.mockReset());

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/billing/plans');
    expect(res.statusCode).toEqual(401);
  });

  it('should return the full server-owned catalog', async () => {
    queueAuth({ subscription_tier: 'pro' });
    const res = await request(app)
      .get('/api/billing/plans')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body.plans)).toBe(true);
    expect(res.body.plans).toHaveLength(3);

    const tiers = res.body.plans.map((p) => p.tier);
    expect(tiers).toEqual(['basic', 'pro', 'enterprise']);
    for (const plan of res.body.plans) {
      expect(plan.id).toBe(plan.tier);
      expect(typeof plan.name).toBe('string');
      expect(typeof plan.price).toBe('string');
      expect(Array.isArray(plan.features)).toBe(true);
      expect(plan.features.length).toBeGreaterThan(0);
      expect(typeof plan.recommended).toBe('boolean');
    }
    expect(res.body.plans.find((p) => p.tier === 'pro').recommended).toBe(true);
    expect(res.body.plans.find((p) => p.tier === 'basic').price).toBe('Δωρεάν');
  });

  it('should not leak mutations back into the catalog', async () => {
    queueAuth();
    const res = await request(app)
      .get('/api/billing/plans')
      .set('Authorization', `Bearer ${userToken()}`);
    res.body.plans[0].features.push('mutated');

    queueAuth();
    const second = await request(app)
      .get('/api/billing/plans')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(second.body.plans[0].features).not.toContain('mutated');
  });
});

describe('Billing portal (POST /api/billing/portal)', () => {
  afterEach(() => db.query.mockReset());

  it('should 401 without a token', async () => {
    const res = await request(app).post('/api/billing/portal');
    expect(res.statusCode).toEqual(401);
  });

  it('should 403 with a clear JSON error in mock mode', async () => {
    queueAuth();
    const res = await request(app)
      .post('/api/billing/portal')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(403);
    expect(res.body.error).toMatch(/live Stripe mode/i);
  });

  it('service-level guard also refuses mock mode', async () => {
    await expect(stripeService.createPortalSession({ user: { id: 2 } }))
      .rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('Subscription reactivate (POST /api/subscriptions/reactivate)', () => {
  afterEach(() => {
    db.query.mockReset();
    audit.logAudit.mockClear();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).post('/api/subscriptions/reactivate');
    expect(res.statusCode).toEqual(401);
  });

  it('should 404 when the user has no subscription', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.error).toMatch(/no subscription/i);
  });

  it('should restore canceled_at_period_end to active (mock mode)', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, stripe_subscription_id: 'mock_sub_2', status: 'canceled_at_period_end' }]
    });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ ok: true, subscription: { id: 7, status: 'active' } });

    const updateCall = db.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /UPDATE subscriptions SET status/.test(sql)
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual(['active', 7]);
    expect(audit.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'subscription.reactivated',
        newValue: { status: 'active' }
      })
    );
  });

  it('should keep an already-active status', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, stripe_subscription_id: null, status: 'active' }]
    });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.subscription.status).toBe('active');
  });

  it('should 409 when the subscription has already ended', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 7, stripe_subscription_id: 'sub_dead', status: 'canceled' }]
    });

    const res = await request(app)
      .post('/api/subscriptions/reactivate')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(409);
    expect(res.body.error).toMatch(/already ended/i);
    expect(db.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && /UPDATE subscriptions SET status/.test(sql)
    )).toBe(false);
    expect(audit.logAudit).not.toHaveBeenCalled();
  });
});
