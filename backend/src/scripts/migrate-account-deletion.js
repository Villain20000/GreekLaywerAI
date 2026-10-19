// Account-deletion grace period: a scheduled timestamp on the user row.
// The retention job purges accounts whose grace period has elapsed.
const db = require('../config/db');

const STATEMENTS = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMPTZ;`,
  `CREATE INDEX IF NOT EXISTS users_deletion_scheduled_for_idx
     ON users(deletion_scheduled_for) WHERE deletion_scheduled_for IS NOT NULL;`
];

async function migrate() {
  console.log('Starting account-deletion migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Account-deletion migration complete (${STATEMENTS.length} statements).`);
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
