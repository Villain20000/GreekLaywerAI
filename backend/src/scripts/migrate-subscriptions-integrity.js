// Subscriptions integrity migration.
//
// Problems this fixes on existing databases:
//   1. No UNIQUE constraint on subscriptions.stripe_subscription_id, while
//      upsertSubscription historically used `ON CONFLICT DO NOTHING` with no
//      conflict target — every replayed webhook quietly inserted a NEW row.
//   2. No index on subscriptions.user_id (slow per-user lookups).
//
// Order of operations (single transaction):
//   1) De-duplicate: keep the NEWEST row (highest id) per non-null
//      stripe_subscription_id and delete older duplicates.
//   2) Create the partial unique index the app-layer upsert now targets:
//      `ON CONFLICT (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL`.
//   3) Create the user_id lookup index.
//
// Idempotent: DELETE only removes duplicates, indexes use IF NOT EXISTS, so
// re-running is a no-op.
const db = require('../config/db');

async function migrate() {
  console.log('Starting subscriptions-integrity migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1) Keep the newest row per stripe_subscription_id; delete older dupes.
    //    Rows with NULL stripe_subscription_id are left untouched (the
    //    partial unique index only constrains non-null values).
    const deduped = await client.query(
      `DELETE FROM subscriptions a
         USING subscriptions b
        WHERE a.stripe_subscription_id IS NOT NULL
          AND a.stripe_subscription_id = b.stripe_subscription_id
          AND a.id < b.id;`
    );
    if (deduped.rowCount) {
      console.log(`  removed ${deduped.rowCount} duplicate subscription row(s)`);
    }

    // 2) One row per Stripe subscription.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_uidx
         ON subscriptions(stripe_subscription_id)
         WHERE stripe_subscription_id IS NOT NULL;`
    );

    // 3) Per-user lookup index.
    await client.query(
      `CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx
         ON subscriptions(user_id);`
    );

    await client.query('COMMIT');
    console.log('subscriptions-integrity migration complete.');
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
