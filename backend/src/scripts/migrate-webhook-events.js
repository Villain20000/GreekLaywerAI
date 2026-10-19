// 1-10: Stripe webhook idempotency store.
//
// Stripe delivers webhooks at-least-once: any non-2xx (or a network blip)
// triggers a retry, so handlers MUST tolerate seeing the same event id
// again. webhook.js claims the evt_… id here BEFORE dispatching; a claim
// that conflicts (already present) means the event was processed and the
// delivery is acknowledged without reprocessing.
//
// Fully idempotent (IF NOT EXISTS) and has no FK dependencies, so it can
// run at any point in the migrate-all chain.
const db = require('../config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
     event_id TEXT PRIMARY KEY,
     processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
   );`,
  // Supports operator pruning (`DELETE … WHERE processed_at < NOW() - …`).
  // Stripe retries for up to ~3 days, so rows can be dropped afterwards.
  `CREATE INDEX IF NOT EXISTS stripe_webhook_events_processed_at_idx
     ON stripe_webhook_events(processed_at);`
];

async function migrate() {
  console.log('Starting Stripe webhook events migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Stripe webhook events migration complete (${STATEMENTS.length} statements).`);
    return { ok: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = migrate;
