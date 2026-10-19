// Email-change verification tokens. The new address is held in `new_email`
// until the token is consumed; only then is users.email updated.
const db = require('../config/db');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS email_change_tokens (
     id SERIAL PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     new_email VARCHAR(255) NOT NULL,
     token_hash VARCHAR(64) NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL,
     used_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS email_change_tokens_token_hash_idx
     ON email_change_tokens(token_hash);`,
  `CREATE INDEX IF NOT EXISTS email_change_tokens_user_id_idx
     ON email_change_tokens(user_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS email_change_tokens_unused_hash_uidx
     ON email_change_tokens(token_hash) WHERE used_at IS NULL;`
];

async function migrate() {
  console.log('Starting email-change tokens migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Email-change tokens migration complete (${STATEMENTS.length} statements).`);
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
