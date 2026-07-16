// One-shot migration: Phase 24 email verification.
//
// Two parts:
//   1. ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ.
//      NULL == unverified. `verified_at` (timestamp) rather than BOOLEAN so
//      we have an audit trail of WHEN the user verified (useful for trust
//      signals and de-duping spam signups).
//   2. CREATE TABLE IF NOT EXISTS email_verification_tokens — same shape as
//      Phase 23 password_reset_tokens but a separate table. TTL is 24h
//      (issued by the route handler) — longer than the 1h reset TTL because
//      users may not check email immediately.
//
// Idempotent: every clause uses ADD COLUMN / CREATE TABLE / CREATE INDEX IF
// NOT EXISTS, so re-running the script is harmless.
const db = require('../config/db');

async function migrate() {
  console.log('Starting email-verification migration: adding users.verified_at + email_verification_tokens...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id              SERIAL PRIMARY KEY,
        user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      VARCHAR(64) NOT NULL,
        expires_at      TIMESTAMPTZ NOT NULL,
        used_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS email_verification_tokens_token_hash_idx
        ON email_verification_tokens(token_hash);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx
        ON email_verification_tokens(user_id);
    `);
    // Defense-in-depth: a partial unique index on (token_hash) WHERE
    // used_at IS NULL makes "two concurrent verifies for the same token
    // both succeed" impossible at the DB layer, even if the app-layer
    // compare-and-set were ever bypassed.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_unused_hash_uidx
        ON email_verification_tokens(token_hash) WHERE used_at IS NULL;
    `);

    await client.query('COMMIT');
    console.log('email-verification migration complete.');

    try {
      const verifyRows = await db.query(
        `SELECT COUNT(*)::int AS n FROM email_verification_tokens`
      );
      console.log('email_verification_tokens row count:', verifyRows.rows[0].n);
      const verifiedUsers = await db.query(
        `SELECT
            COUNT(*) FILTER (WHERE verified_at IS NULL)::int AS unverified,
            COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified
         FROM users`
      );
      console.log('verified_at distribution:', verifiedUsers.rows[0]);
    } catch (e) {
      console.warn('Post-migration verification query failed (non-fatal):', e.message);
    }

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
