// Payment-history store. Populated from Stripe invoice webhooks and read by
// GET /api/subscriptions/invoices. Idempotent; depends on users(id) only.
const db = require('../config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS invoices (
     id SERIAL PRIMARY KEY,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     stripe_invoice_id VARCHAR(255) UNIQUE NOT NULL,
     stripe_customer_id VARCHAR(255),
     stripe_subscription_id VARCHAR(255),
     amount_due INT,
     amount_paid INT,
     currency VARCHAR(10),
     status VARCHAR(50),
     hosted_invoice_url TEXT,
     invoice_pdf TEXT,
     period_start TIMESTAMPTZ,
     period_end TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS invoices_user_id_created_at_idx
     ON invoices(user_id, created_at DESC);`
];

async function migrate() {
  console.log('Starting invoices migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Invoices migration complete (${STATEMENTS.length} statements).`);
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
