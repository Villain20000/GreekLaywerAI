// Payment history: Stripe invoice webhooks, GET /api/subscriptions/invoices,
// and the production mock-mode guard.
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

function invoiceRow(overrides = {}) {
  return {
    id: 1,
    stripe_invoice_id: 'in_1',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    amount_due: 1999,
    amount_paid: 1999,
    currency: 'eur',
    status: 'paid',
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
    invoice_pdf: 'https://invoice.stripe.com/i/in_1.pdf',
    period_start: '2025-01-01T00:00:00.000Z',
    period_end: '2025-02-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides
  };
}

afterAll(() => {
  for (const key of STRIPE_ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe('GET /api/subscriptions/invoices', () => {
  afterEach(() => db.query.mockReset());

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/subscriptions/invoices');
    expect(res.statusCode).toEqual(401);
  });

  it('should paginate and scope the invoices to the caller', async () => {
    queueAuth({ id: 9 });
    db.query.mockResolvedValueOnce({ rows: [{ total: 3 }] });
    db.query.mockResolvedValueOnce({
      rows: [invoiceRow({ id: 4 }), invoiceRow({ id: 3 })]
    });

    const res = await request(app)
      .get('/api/subscriptions/invoices?limit=2&offset=2')
      .set('Authorization', `Bearer ${userToken(9)}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(2);
    expect(res.body.invoices).toHaveLength(2);

    const countCall = db.query.mock.calls[1];
    expect(countCall[0]).toMatch(/COUNT\(\*\).*FROM invoices/);
    expect(countCall[0]).toMatch(/WHERE user_id = \$1/);
    expect(countCall[1]).toEqual([9]);

    const rowsCall = db.query.mock.calls[2];
    expect(rowsCall[0]).toMatch(/FROM invoices/);
    expect(rowsCall[0]).toMatch(/WHERE user_id = \$1/);
    expect(rowsCall[0]).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(rowsCall[0]).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(rowsCall[1]).toEqual([9, 2, 2]);
  });

  it('should default to 20 and clamp the limit to 100', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const defaults = await request(app)
      .get('/api/subscriptions/invoices')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(defaults.statusCode).toEqual(200);
    expect(defaults.body.limit).toBe(20);
    expect(defaults.body.offset).toBe(0);
    expect(defaults.body.total).toBe(0);

    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const clamped = await request(app)
      .get('/api/subscriptions/invoices?limit=1000&offset=-5')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(clamped.statusCode).toEqual(200);
    expect(clamped.body.limit).toBe(100);
    expect(clamped.body.offset).toBe(0);

    const rowsCall = db.query.mock.calls[db.query.mock.calls.length - 1];
    expect(rowsCall[1]).toEqual([2, 100, 0]);
  });
});

describe('invoice webhook handling', () => {
  afterEach(() => db.query.mockReset());

  it('invoice.paid upserts the invoice and resolves the owner by subscription id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ user_id: 2 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await stripeService.handleWebhookEvent({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          amount_due: 1999,
          amount_paid: 1999,
          currency: 'eur',
          status: 'paid',
          hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
          invoice_pdf: 'https://invoice.stripe.com/i/in_1.pdf',
          period_start: 1735689600,
          period_end: 1738368000
        }
      }
    });

    expect(result).toEqual({ handled: true });

    const [ownerSql, ownerParams] = db.query.mock.calls[0];
    expect(ownerSql).toMatch(/FROM subscriptions WHERE stripe_subscription_id = \$1/);
    expect(ownerParams).toEqual(['sub_1']);

    const [insertSql, insertParams] = db.query.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO invoices/);
    expect(insertSql).toMatch(/ON CONFLICT \(stripe_invoice_id\) DO UPDATE SET/);
    expect(insertSql).toMatch(/amount_due = EXCLUDED.amount_due/);
    expect(insertSql).toMatch(/updated_at = CURRENT_TIMESTAMP/);
    expect(insertParams).toEqual([
      2,
      'in_1',
      'cus_1',
      'sub_1',
      1999,
      1999,
      'eur',
      'paid',
      'https://invoice.stripe.com/i/in_1',
      'https://invoice.stripe.com/i/in_1.pdf',
      '2025-01-01T00:00:00.000Z',
      '2025-02-01T00:00:00.000Z'
    ]);
  });

  it('invoice.payment_failed falls back to the customer id and upserts the status', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })              // by subscription id
      .mockResolvedValueOnce({ rows: [{ user_id: 3 }] }) // by customer id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // upsert

    const result = await stripeService.handleWebhookEvent({
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_2',
          customer: 'cus_2',
          subscription: 'sub_2',
          amount_due: 4900,
          amount_paid: 0,
          currency: 'eur',
          status: 'open',
          period_start: 1735689600,
          period_end: 1738368000
        }
      }
    });

    expect(result).toEqual({ handled: true });
    expect(db.query.mock.calls[1][0]).toMatch(/WHERE stripe_customer_id = \$1/);
    expect(db.query.mock.calls[1][1]).toEqual(['cus_2']);

    const insertParams = db.query.mock.calls[2][1];
    expect(insertParams[0]).toBe(3);
    expect(insertParams[5]).toBe(0);
    expect(insertParams[7]).toBe('open');
  });

  it('invoice.payment_succeeded is handled by the same upsert path', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ user_id: 2 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await stripeService.handleWebhookEvent({
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_3', customer: 'cus_1', subscription: 'sub_1', status: 'paid' } }
    });

    expect(result).toEqual({ handled: true });
    expect(db.query.mock.calls[1][0]).toMatch(/INSERT INTO invoices/);
  });

  it('stores the invoice with a null owner when nothing resolves — without throwing', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })              // by customer id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // upsert
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    let result;
    try {
      result = await stripeService.handleWebhookEvent({
        type: 'invoice.paid',
        data: { object: { id: 'in_orphan', customer: 'cus_unknown', status: 'paid' } }
      });
    } finally {
      warn.mockRestore();
    }

    expect(result).toEqual({ handled: true });
    expect(db.query.mock.calls[1][1][0]).toBeNull();
  });

  it('keeps processing when the owner lookup itself fails', async () => {
    db.query
      .mockRejectedValueOnce(new Error('db hiccup'))      // by customer id
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // upsert
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    let result;
    try {
      result = await stripeService.handleWebhookEvent({
        type: 'invoice.paid',
        data: { object: { id: 'in_retry', customer: 'cus_1', status: 'paid' } }
      });
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }

    expect(result).toEqual({ handled: true });
    expect(db.query.mock.calls[1][1][0]).toBeNull();
  });
});

describe('production mock-mode guard', () => {
  afterEach(() => {
    process.env.NODE_ENV = 'test';
    jest.resetModules();
  });

  function loadProductionService({ key }) {
    jest.resetModules();
    process.env.NODE_ENV = 'production';
    if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = key;
    return require('../src/services/stripeService');
  }

  it('refuses to simulate a checkout with the mock key', async () => {
    const svc = loadProductionService({ key: 'sk_test_mock' });

    expect(svc.isMockMode()).toBe(true);
    expect(svc.isConfigured()).toBe(false);
    await expect(
      svc.createCheckoutSession({ tier: 'pro', user: { id: 2, email: 'user@nomos.ai' } })
    ).rejects.toMatchObject({ statusCode: 503, message: /Stripe billing is not configured/ });
  });

  it('refuses to simulate a checkout when the key is missing', async () => {
    const svc = loadProductionService({ key: undefined });

    await expect(
      svc.createCheckoutSession({ tier: 'pro', user: { id: 2, email: 'user@nomos.ai' } })
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      svc.completeMockCheckout({ user: { id: 2 }, tier: 'pro' })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('keeps mock mode working outside production', async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
    const svc = require('../src/services/stripeService');

    const session = await svc.createCheckoutSession({
      tier: 'pro',
      user: { id: 2, email: 'user@nomos.ai' }
    });
    expect(session.url).toContain('mock_payment=success');
  });
});
