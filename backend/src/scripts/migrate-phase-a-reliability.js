// One-shot migration: Phase A reliability columns and indexes.
// Safe to re-run on existing deployments.
const db = require('../config/db');

async function migrate() {
  console.log('Starting Phase A reliability migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS title VARCHAR(255);'
    );
    // Preserve titles uploaded before the dedicated column existed.
    await client.query(
      `UPDATE legal_documents
       SET title = NULLIF(LEFT(metadata->>'title', 255), '')
       WHERE title IS NULL AND metadata ? 'title';`
    );
    await client.query(
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_job_id VARCHAR(255);'
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS messages_source_job_id_uidx
       ON messages(source_job_id) WHERE source_job_id IS NOT NULL;`
    );
    await client.query('COMMIT');
    console.log('Phase A reliability migration complete.');
    return { ok: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Phase A reliability migration failed:', error);
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
