// One-shot migration: Phase B cited-answer metadata.
// Safe to re-run on existing deployments.
const db = require('../config/db');

async function migrate() {
  console.log('Starting Phase B citations migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE messages
       ADD COLUMN IF NOT EXISTS citation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`
    );
    await client.query('COMMIT');
    console.log('Phase B citations migration complete.');
    return { ok: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Phase B citations migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrate;
