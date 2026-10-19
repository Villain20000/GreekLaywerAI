// Stripe service unit tests.
//
// Covers the P0 fixes:
//   - upsertSubscription targets the partial unique index (no duplicate rows);
//   - canceled/terminated subscriptions downgrade users to 'basic';
//   - unknown Stripe price ids NEVER guess a tier;
//   - completeMockCheckout only works in mock mode and funnels through the
//     same upsert + tier-sync path as a real webhook.
//
// stripeService resolves STRIPE_SECRET_KEY / STRIPE_PRICE_ID_* at module load,
// so each scenario loads a fresh module registry via loadService().
process.env.NODE_ENV = 'test';

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  getAuditLogs: jest.fn().mockResolvedValue([]),
  deleteAuditLogsForUser: jest.fn().mockResolvedValue(undefined)
}));

/**
 * Load a fresh stripeService with a controlled environment.
 * @param {object} opts
 * @param {string|undefined} opts.secretKey  undefined → mock mode (no key)
 * @param {object} opts.priceIds             e.g. { pro: 'price_pro' }
 */
function loadService({ secretKey, priceIds = {} } = {}) {
  jest.resetModules();

  if (secretKey === undefined) {
    delete process.env.STRIPE_SECRET_KEY;
  } else {
    process.env.STRIPE_SECRET_KEY = secretKey;
  }
  for (const tier of ['BASIC', 'PRO', 'ENTERPRISE']) {
    delete process.env[`STRIPE_PRICE_ID_${tier}`];
  }
  for (const [tier, value] of Object.entries(priceIds)) {
    process.env[`STRIPE_PRICE_ID_${tier.toUpperCase()}`] = value;
  }

  const svc = require('../src/services/stripeService');
  const dbMock = require('../src/config/db');
  const auditMock = require('../src/services/auditLog');
  return { svc, dbMock, auditMock };
}

describe('stripeService', () => {
  // jest workers share process.env across test FILES: leaving a live
  // STRIPE_SECRET_KEY behind would flip subscriptionsGdpr.test.js out of mock
  // mode if it runs next in the same worker. Snapshot + restore, always.
  const STRIPE_ENV_KEYS = [
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_ID_BASIC',
    'STRIPE_PRICE_ID_PRO',
    'STRIPE_PRICE_ID_ENTERPRISE'
  ];
  let stripeEnvSnap;

  beforeEach(() => {
    stripeEnvSnap = {};
    for (const key of STRIPE_ENV_KEYS) stripeEnvSnap[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of STRIPE_ENV_KEYS) {
      if (stripeEnvSnap[key] === undefined) delete process.env[key];
      else process.env[key] = stripeEnvSnap[key];
    }
    jest.resetModules();
  });

  describe('upsertSubscription', () => {
    it('upserts on the partial unique index and syncs the tier', async () => {
      const { svc, dbMock, auditMock } = loadService();
      dbMock.query
        .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // INSERT ... ON CONFLICT ... RETURNING
        .mockResolvedValueOnce({ rows: [] });         // UPDATE users

      const result = await svc.upsertSubscription({
        userId: 2,
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_1',
        status: 'active',
        currentPeriodEnd: '2026-12-01T00:00:00.000Z',
        tier: 'pro'
      });

      expect(result).toEqual({ id: 5 });
      const insertSql = dbMock.query.mock.calls[0][0];
      expect(insertSql).toMatch(
        /ON CONFLICT \(stripe_subscription_id\) WHERE stripe_subscription_id IS NOT NULL/
      );
      expect(insertSql).toMatch(/DO UPDATE SET/);

      const userUpdate = dbMock.query.mock.calls[1];
      expect(userUpdate[0]).toMatch(/UPDATE users SET subscription_tier/);
      expect(userUpdate[1]).toEqual(['pro', 2]);
      expect(auditMock.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.tier_changed' })
      );
    });

    it('uses a plain INSERT when there is no stripe_subscription_id', async () => {
      const { svc, dbMock } = loadService();
      dbMock.query.mockResolvedValueOnce({ rows: [{ id: 6 }] });

      await svc.upsertSubscription({
        userId: 2,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        status: 'incomplete',
        currentPeriodEnd: null
      });

      const insertSql = dbMock.query.mock.calls[0][0];
      expect(insertSql).toMatch(/INSERT INTO subscriptions/);
      expect(insertSql).not.toMatch(/ON CONFLICT/);
    });
  });

  describe('handleWebhookEvent — subscription lifecycle', () => {
    it('downgrades the user to basic on customer.subscription.deleted', async () => {
      const { svc, dbMock, auditMock } = loadService();
      dbMock.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // UPDATE subscriptions
        .mockResolvedValueOnce({ rows: [{ user_id: 2 }] })  // SELECT user_id
        .mockResolvedValueOnce({ rows: [] });               // UPDATE users tier basic

      const result = await svc.handleWebhookEvent({
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: 'sub_1',
            status: 'canceled',
            current_period_end: null,
            items: { data: [] }
          }
        }
      });

      expect(result.handled).toBe(true);
      const tierUpdate = dbMock.query.mock.calls[2];
      expect(tierUpdate[0]).toMatch(/UPDATE users SET subscription_tier = 'basic'/);
      expect(tierUpdate[1]).toEqual([2]);
      expect(auditMock.logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'subscription.downgraded' })
      );
    });

    it('mirrors the priced tier on an active customer.subscription.updated', async () => {
      const { svc, dbMock } = loadService({ priceIds: { pro: 'price_pro' } });
      dbMock.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // UPDATE subscriptions
        .mockResolvedValueOnce({ rows: [{ user_id: 2 }] })  // SELECT user_id
        .mockResolvedValueOnce({ rows: [] });               // UPDATE users

      await svc.handleWebhookEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'active',
            current_period_end: 1893456000,
            items: { data: [{ price: { id: 'price_pro' } }] }
          }
        }
      });

      const tierUpdate = dbMock.query.mock.calls[2];
      expect(tierUpdate[0]).toMatch(/UPDATE users SET subscription_tier = \$1/);
      expect(tierUpdate[1]).toEqual(['pro', 2]);
    });

    it('keeps the current tier (never guesses) when the price id is unknown', async () => {
      const { svc, dbMock, auditMock } = loadService();
      auditMock.logAudit.mockClear();
      dbMock.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })   // UPDATE subscriptions
        .mockResolvedValueOnce({ rows: [{ user_id: 2 }] }); // SELECT user_id

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await svc.handleWebhookEvent({
          type: 'customer.subscription.updated',
          data: {
            object: {
              id: 'sub_1',
              status: 'active',
              current_period_end: null,
              items: { data: [{ price: { id: 'price_unknown' } }] }
            }
          }
        });
      } finally {
        warn.mockRestore();
      }

      // Only the two queries above — no users UPDATE, no tier audit.
      expect(dbMock.query).toHaveBeenCalledTimes(2);
      expect(auditMock.logAudit).not.toHaveBeenCalled();
    });

    it('keeps the current tier during dunning (past_due)', async () => {
      const { svc, dbMock } = loadService();
      dbMock.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ user_id: 2 }] });

      await svc.handleWebhookEvent({
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_1',
            status: 'past_due',
            current_period_end: null,
            items: { data: [] }
          }
        }
      });

      expect(dbMock.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('completeMockCheckout', () => {
    it('applies the tier through the same upsert path in mock mode', async () => {
      const { svc, dbMock } = loadService();
      dbMock.query
        .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // upsert INSERT
        .mockResolvedValueOnce({ rows: [] });         // UPDATE users

      const result = await svc.completeMockCheckout({ user: { id: 2 }, tier: 'enterprise' });

      expect(result).toEqual({ tier: 'enterprise', status: 'active' });
      expect(dbMock.query.mock.calls[0][0]).toMatch(/ON CONFLICT/);
      expect(dbMock.query.mock.calls[1][0]).toMatch(/UPDATE users SET subscription_tier/);
      expect(dbMock.query.mock.calls[1][1]).toEqual(['enterprise', 2]);
    });

    it('throws in live Stripe mode', async () => {
      const { svc } = loadService({ secretKey: 'sk_test_liveish' });
      await expect(
        svc.completeMockCheckout({ user: { id: 2 }, tier: 'pro' })
      ).rejects.toThrow(/mock mode/i);
    });
  });
});
