// One-shot migration: Phase C answer-feedback quality loop.
// Safe to re-run on existing deployments.
const db = require('../config/db');

async function migrate() {
  console.log('Starting Phase C feedback migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_feedback (
        id SERIAL PRIMARY KEY,
        message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        helpful BOOLEAN NOT NULL,
        reason VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (message_id, user_id)
      );
    `);
    await client.query(
      'ALTER TABLE message_feedback ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS message_feedback_created_at_idx ON message_feedback(created_at);'
    );
    // A partially-created legacy table may lack the UNIQUE constraint and
    // contain duplicate votes. Keep the newest row for each user/message
    // pair before enforcing the idempotent uniqueness boundary.
    await client.query(
      `DELETE FROM message_feedback older
       USING message_feedback newer
       WHERE older.message_id = newer.message_id
         AND older.user_id = newer.user_id
         AND older.id < newer.id;`
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS message_feedback_message_user_uidx
       ON message_feedback(message_id, user_id);`
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS message_feedback_helpful_idx ON message_feedback(helpful);'
    );
    await client.query('COMMIT');
    console.log('Phase C feedback migration complete.');
    return { ok: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Phase C feedback migration failed:', error);
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
