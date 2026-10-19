// Store the original uploaded document bytes alongside the extracted text so
// users can download the exact file they uploaded. Existing rows keep NULL and
// fall back to the parsed-text download path.
const db = require('../config/db');

const STATEMENTS = [
  `ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS original_file BYTEA;`,
  `ALTER TABLE legal_documents ADD COLUMN IF NOT EXISTS file_size INTEGER;`
];

async function migrate() {
  console.log('Starting document originals migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Document originals migration complete (${STATEMENTS.length} statements).`);
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
