// Phase 29: Real Stripe integration.
//
// Two modes:
//   - Mock mode (no STRIPE_SECRET_KEY or value === 'sk_test_mock'): returns a
//     local mock checkout URL so dev / tests keep working without Stripe.
//     This preserves the pre-Phase-29 behavior and the api.test.js contract.
//   - Live mode (real sk_test_/sk_live_ key): creates a real Stripe Checkout
//     Session (mode: 'subscription') with price IDs read from env vars, and
//     handles webhook events to populate `subscriptions` + `users`.

const Stripe = require('stripe');
const db = require('../config/db');
const { logAudit } = require('./auditLog');

const MOCK_KEY = 'sk_test_mock';
const stripeKey = process.env.STRIPE_SECRET_KEY || MOCK_KEY;
const stripe = Stripe(stripeKey);

const mockMode = stripeKey === MOCK_KEY;

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4200';

// Price IDs per tier, from the Stripe Dashboard. Configure via env vars.
const TIER_PRICE_IDS = {
  basic: process.env.STRIPE_PRICE_ID_BASIC,
  pro: process.env.STRIPE_PRICE_ID_PRO,
  enterprise: process.env.STRIPE_PRICE_ID_ENTERPRISE
};

// 2-5: Server-owned plan catalog. The billing UI renders this payload instead
// of hardcoding plan names/prices/features, so copy changes (and the quota
// numbers advertised here) ship with the API. `id` and `tier` are the same
// value — `tier` matches the /create-checkout-session body field.
const PLAN_CATALOG = [
  {
    id: 'basic',
    tier: 'basic',
    name: 'Basic',
    price: 'Δωρεάν',
    features: [
      '20 ερωτήματα AI / ημέρα',
      'Έγγραφα: έως 10',
      'Αναζήτηση στα έγγραφα'
    ],
    recommended: false
  },
  {
    id: 'pro',
    tier: 'pro',
    name: 'Pro',
    price: '19 € / μήνα',
    features: [
      '60 ερωτήματα AI / ημέρα',
      'Απεριόριστα έγγραφα',
      'Προτεραιότητα επεξεργασίας'
    ],
    recommended: true
  },
  {
    id: 'enterprise',
    tier: 'enterprise',
    name: 'Enterprise',
    price: '49 € / μήνα',
    features: [
      '120 ερωτήματα AI / ημέρα',
      'Απεριόριστα έγγραφα',
      'Υποστήριξη με προτεραιότητα'
    ],
    recommended: false
  }
];

/**
 * Return the plan catalog (defensive copies so callers can't mutate it).
 * @returns {Array<object>}
 */
function getPlans() {
  return PLAN_CATALOG.map((plan) => ({ ...plan, features: [...plan.features] }));
}

function isConfigured() {
  return !mockMode;
}

/**
 * Whether the service is running against the local mock (no real Stripe key).
 * @returns {boolean}
 */
function isMockMode() {
  return mockMode;
}

/**
 * Create a Stripe Checkout Session for the given tier.
 * @param {object} opts { tier, user }
 * @returns {Promise<{id: string, url: string}>}
 */
async function createCheckoutSession({ tier, user }) {
  if (mockMode) {
    const mockUrl = `${APP_BASE_URL}/chat?mock_payment=success&tier=${encodeURIComponent(tier)}`;
    return { id: `mock_cs_${Date.now()}`, url: mockUrl };
  }

  const priceId = TIER_PRICE_IDS[tier];
  if (!priceId) {
    throw new Error(
      `No STRIPE_PRICE_ID_${tier.toUpperCase()} env var configured for tier '${tier}'.`
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${APP_BASE_URL}/chat?checkout=success`,
    cancel_url: `${APP_BASE_URL}/billing?checkout=cancelled`,
    client_reference_id: String(user.id),
    customer_email: user.email,
    metadata: { user_id: String(user.id), tier }
  });

  return { id: session.id, url: session.url };
}

/**
 * Upsert a subscription row for a user and sync users.subscription_tier.
 * Shared by the webhook handler and the subscriptions route.
 *
 * The INSERT ... ON CONFLICT targets the partial unique index
 * `subscriptions_stripe_subscription_id_uidx` (see
 * migrate-subscriptions-integrity.js) so replays of the same webhook event
 * update the existing row instead of inserting duplicates. Rows without a
 * stripe_subscription_id (e.g. legacy data) take the plain INSERT path.
 */
async function upsertSubscription({ userId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd, tier }) {
  let result;
  if (stripeSubscriptionId) {
    result = await db.query(
      `INSERT INTO subscriptions
         (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         current_period_end = EXCLUDED.current_period_end,
         stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id)
       RETURNING id`,
      [userId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd]
    );
  } else {
    result = await db.query(
      `INSERT INTO subscriptions
         (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, stripeCustomerId, stripeSubscriptionId, status, currentPeriodEnd]
    );
  }

  if (tier) {
    await db.query(
      `UPDATE users SET subscription_tier = $1 WHERE id = $2`,
      [tier, userId]
    );
    await logAudit({
      userId,
      action: 'subscription.tier_changed',
      resourceType: 'subscription',
      resourceId: stripeSubscriptionId,
      newValue: { tier, status }
    });
  }

  return result.rows[0] || { updated: true };
}

/**
 * Mock-mode checkout completion. When the dev mock checkout redirects back
 * with `?mock_payment=success&tier=…`, the frontend calls
 * POST /api/billing/mock-complete, which funnels through the exact same
 * upsert + tier-sync path a real `checkout.session.completed` webhook uses.
 * Never available in live Stripe mode.
 */
async function completeMockCheckout({ user, tier }) {
  if (!mockMode) {
    throw new Error('Mock checkout is only available in mock mode');
  }
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await upsertSubscription({
    userId: user.id,
    stripeCustomerId: `mock_cus_${user.id}`,
    stripeSubscriptionId: `mock_sub_${user.id}`,
    status: 'active',
    currentPeriodEnd: periodEnd,
    tier
  });
  return { tier, status: 'active' };
}

/**
 * Create a Stripe Billing Portal session for the caller.
 *
 * Live mode only: mock mode has no real customer, so the route maps the
 * thrown 403 into the same clear JSON shape as /mock-complete's live-mode
 * guard. The customer id is taken from the user's latest subscription row.
 * A user who never checked out gets a 404 instead of a Stripe API error.
 *
 * @param {object} opts { user, returnUrl? }
 * @returns {Promise<{id: string, url: string}>}
 */
async function createPortalSession({ user, returnUrl }) {
  if (mockMode) {
    const err = new Error('Customer portal is only available in live Stripe mode');
    err.statusCode = 403;
    throw err;
  }

  const result = await db.query(
    `SELECT stripe_customer_id
     FROM subscriptions
     WHERE user_id = $1
       AND stripe_customer_id IS NOT NULL
       AND stripe_customer_id <> ''
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [user.id]
  );
  const customer = result.rows[0] && result.rows[0].stripe_customer_id;
  if (!customer) {
    const err = new Error('No Stripe customer found for this account');
    err.statusCode = 404;
    throw err;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: returnUrl || `${APP_BASE_URL}/billing`
  });
  return { id: session.id, url: session.url };
}

/**
 * Undo a scheduled cancellation (`cancel_at_period_end=false`).
 * Mock mode / rows without a Stripe subscription id are a local-only no-op.
 *
 * @param {object} opts { stripeSubscriptionId }
 * @returns {Promise<{status: string}|null>}
 */
async function resumeSubscription({ stripeSubscriptionId }) {
  if (mockMode || !stripeSubscriptionId) return null;
  const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
    cancel_at_period_end: false
  });
  return { status: subscription.status || 'active' };
}

/**
 * Handle a verified Stripe webhook event.
 * @param {object} event Stripe event object (constructEvent output)
 */
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = Number(session.client_reference_id || (session.metadata && session.metadata.user_id));
      const tier = session.metadata && session.metadata.tier;
      if (!userId) return { handled: false, reason: 'no user_id' };

      let status = 'active';
      let currentPeriodEnd = null;
      if (session.subscription) {
        try {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          status = sub.status;
          currentPeriodEnd = sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null;
        } catch (err) {
          console.error('[STRIPE] Failed to retrieve subscription:', err.message);
        }
      }

      await upsertSubscription({
        userId,
        stripeCustomerId: typeof session.customer === 'string' ? session.customer : null,
        stripeSubscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
        status,
        currentPeriodEnd,
        tier
      });
      return { handled: true };
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const status = sub.status;
      const currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;

      await db.query(
        `UPDATE subscriptions
         SET status = $2, current_period_end = $3
         WHERE stripe_subscription_id = $1`,
        [sub.id, status, currentPeriodEnd]
      );

      // Find the owning user and sync their tier from the subscription's
      // terminal state:
      //   active/trialing     → mirror the priced tier (fail closed on
      //                         unknown price ids — never guess a tier);
      //   canceled/unpaid/    → downgrade to basic (cancellation must
      //   incomplete_expired     actually revoke paid features);
      //   past_due/incomplete → keep the current tier during dunning.
      const owner = await db.query(
        `SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
      if (owner.rows.length) {
        const ownerId = owner.rows[0].user_id;
        const isActive = status === 'active' || status === 'trialing';
        const isTerminated =
          status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired';

        if (isActive) {
          const priceId =
            sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price &&
            sub.items.data[0].price.id;
          const tier = Object.keys(TIER_PRICE_IDS).find((t) => TIER_PRICE_IDS[t] === priceId);
          if (tier) {
            await db.query(
              `UPDATE users SET subscription_tier = $1 WHERE id = $2`,
              [tier, ownerId]
            );
            await logAudit({
              userId: ownerId,
              action: 'subscription.tier_changed',
              resourceType: 'subscription',
              resourceId: sub.id,
              newValue: { tier, status }
            });
          } else {
            console.warn(
              `[STRIPE] Unknown price id '${priceId || '(none)'}' for subscription ${sub.id} — keeping the user's current tier.`
            );
          }
        } else if (isTerminated) {
          await db.query(
            `UPDATE users SET subscription_tier = 'basic' WHERE id = $1`,
            [ownerId]
          );
          await logAudit({
            userId: ownerId,
            action: 'subscription.downgraded',
            resourceType: 'subscription',
            resourceId: sub.id,
            newValue: { tier: 'basic', status }
          });
        }
      }
      return { handled: true };
    }

    default:
      return { handled: false, reason: `unhandled event type ${event.type}` };
  }
}

module.exports = {
  isConfigured,
  isMockMode,
  getPlans,
  createCheckoutSession,
  createPortalSession,
  resumeSubscription,
  completeMockCheckout,
  handleWebhookEvent,
  upsertSubscription
};
