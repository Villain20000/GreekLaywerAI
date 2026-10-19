// 1-4: Daily usage counters for tier quotas.
//
// One row per (user, UTC day, kind). `kind` is intentionally open-ended so
// future quotas ('ai' today; e.g. 'exports' later) can share the table. The
// composite primary key also serves the only lookup pattern
// (`user_id + day + kind`) and makes the counter UPSERT atomic.
//
// Fully idempotent (IF NOT EXISTS), so it can run on every deploy / from
// migrate-all.js. `users.id` is SERIAL (integer) in database/init/schema.sql,
// hence INTEGER here; ON DELETE CASCADE keeps GDPR account deletion complete.
const db = require('../config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS usage_counters (
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     day DATE NOT NULL,
     kind TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day, kind)
   );`
];

async function migrate() {
  console.log('Starting usage counters migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Usage counters migration complete (${STATEMENTS.length} statements).`);
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
