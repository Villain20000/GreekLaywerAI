#!/usr/bin/env node
// Register (or update) the Stripe webhook endpoint for this deployment.
//
// Usage:
//   node src/scripts/configure-stripe-webhook.js [--dry-run]
//
// Reads STRIPE_SECRET_KEY (or STRIPE_SECRET_KEY_FILE) and APP_BASE_URL, then
// ensures ${APP_BASE_URL}/api/billing/webhook exists with the events the
// billing code handles. The signing secret is only returned when an endpoint
// is created; store it as STRIPE_WEBHOOK_SECRET (or in the *_FILE secret) and
// restart the backend. Existing endpoints cannot reveal their secret — use
// the Stripe Dashboard or rotate it there.

const Stripe = require('stripe');
const { getSecret } = require('../config/secrets');

const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed'
];

const DRY_RUN = process.argv.includes('--dry-run');

function normalizeBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  if (!value) {
    throw new Error('APP_BASE_URL is required (e.g. https://app.example.com)');
  }

  let url;
  try {
    url = new URL(value);
  } catch (_err) {
    throw new Error(`APP_BASE_URL is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`APP_BASE_URL must use http or https: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('APP_BASE_URL must be a bare origin without credentials, query or hash');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`APP_BASE_URL must not include a path: ${value}`);
  }

  return url.origin;
}

function normalizeEndpointUrl(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

async function listWebhookEndpoints(stripe) {
  const endpoints = [];
  let startingAfter = null;

  do {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.webhookEndpoints.list(params);
    endpoints.push(...page.data);
    startingAfter = page.has_more && page.data.length > 0
      ? page.data[page.data.length - 1].id
      : null;
  } while (startingAfter);

  return endpoints;
}

function missingEvents(existingEvents) {
  const enabled = Array.isArray(existingEvents) ? existingEvents : [];
  if (enabled.includes('*')) return [];
  return WEBHOOK_EVENTS.filter((event) => !enabled.includes(event));
}

async function main() {
  const secretKey = getSecret('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  if (secretKey === 'sk_test_mock') {
    throw new Error('STRIPE_SECRET_KEY is sk_test_mock; mock mode has no Stripe webhooks to configure');
  }

  const baseUrl = normalizeBaseUrl(process.env.APP_BASE_URL);
  const webhookUrl = `${baseUrl}/api/billing/webhook`;
  const stripe = Stripe(secretKey);

  console.log(
    `[stripe] ${/^(?:sk|rk)_live_/.test(secretKey) ? 'LIVE' : 'test'} mode; target ${webhookUrl}` +
    (DRY_RUN ? ' (dry run, no changes)' : '')
  );

  const endpoints = await listWebhookEndpoints(stripe);
  const existing = endpoints.find(
    (endpoint) => normalizeEndpointUrl(endpoint.url) === webhookUrl
  );

  if (!existing) {
    if (DRY_RUN) {
      console.log(`[stripe] would create endpoint ${webhookUrl}`);
      console.log(`[stripe] enabled events: ${WEBHOOK_EVENTS.join(', ')}`);
      return;
    }

    const created = await stripe.webhookEndpoints.create({
      url: webhookUrl,
      enabled_events: WEBHOOK_EVENTS,
      description: 'NomosAI billing webhook'
    });

    console.log(`[stripe] created endpoint ${created.id} (${created.status})`);
    console.log(`[stripe] enabled events: ${WEBHOOK_EVENTS.join(', ')}`);
    if (created.secret) {
      console.log('');
      console.log('=== STRIPE WEBHOOK SIGNING SECRET (shown once) ===');
      console.log(created.secret);
      console.log('==================================================');
      console.log('Store it as STRIPE_WEBHOOK_SECRET (or mount it via STRIPE_WEBHOOK_SECRET_FILE)');
      console.log('and restart the backend. It cannot be retrieved again from this script.');
    } else {
      console.log('[stripe] No signing secret returned; retrieve it from the Stripe Dashboard.');
    }
    return;
  }

  console.log(`[stripe] found endpoint ${existing.id} (status=${existing.status})`);
  if (existing.status !== 'enabled') {
    console.log('[stripe] WARNING: the endpoint is disabled; enable it in the Stripe Dashboard.');
  }

  const missing = missingEvents(existing.enabled_events);
  if (missing.length === 0) {
    console.log('[stripe] endpoint already subscribes to every required event; nothing to do.');
    console.log('[stripe] Existing signing secrets are not retrievable here; use the Stripe Dashboard if needed.');
    return;
  }

  const updatedEvents = [
    ...WEBHOOK_EVENTS,
    ...(existing.enabled_events || []).filter(
      (event) => event !== '*' && !WEBHOOK_EVENTS.includes(event)
    )
  ];

  if (DRY_RUN) {
    console.log(`[stripe] would add events: ${missing.join(', ')}`);
    console.log(`[stripe] resulting enabled events: ${updatedEvents.join(', ')}`);
    return;
  }

  await stripe.webhookEndpoints.update(existing.id, { enabled_events: updatedEvents });
  console.log(`[stripe] added events: ${missing.join(', ')}`);
  console.log('[stripe] Existing signing secrets are not retrievable here; use the Stripe Dashboard if needed.');
}

if (require.main === module) {
  main().then(
    () => {
      process.exitCode = 0;
    },
    (err) => {
      // Stripe errors never include the API key; print a bounded message only.
      console.error(`[stripe] ${err && err.message ? err.message : 'webhook configuration failed'}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, normalizeBaseUrl, WEBHOOK_EVENTS };
