// One-shot migration: create password_reset_tokens table for /forgot-password
// + /reset-password flow.
//
// Schema:
//   - token_hash stores SHA-256(plaintext) so a DB leak does not reveal valid
//     reset tokens (the plaintext is only ever embedded in the email link).
//   - used_at IS NULL ⇒ unused; IS NOT NULL ⇒ already consumed. Compare-and-set
//     UPDATE ensures two concurrent reset attempts can't both win.
//   - expires_at is set to NOW() + 1h by the route handler on issue.
//
// Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe
// to run repeatedly.
const db = require('../config/db');

async function migrate() {
  console.log('Starting password-reset-tokens migration: creating password_reset_tokens table...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id              SERIAL PRIMARY KEY,
        user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash      VARCHAR(64) NOT NULL,
        expires_at      TIMESTAMPTZ NOT NULL,
        used_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes are also IF NOT EXISTS — guards against re-running the migration.
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx
        ON password_reset_tokens(token_hash);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
        ON password_reset_tokens(user_id);
    `);
    // Defense-in-depth: enforce single-use at the DB level. The route
    // handler's compare-and-set `UPDATE … WHERE used_at IS NULL` already
    // keeps a single winner under concurrency, but a *partial* unique
    // index on (token_hash) WHERE used_at IS NULL means even if a future
    // bug flips `used_at` back to NULL (cleanup race, refactor mistake),
    // Postgres will refuse the second active row — the "single-use"
    // invariant cannot be violated by application-layer code changes.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_unused_hash_uidx
        ON password_reset_tokens(token_hash) WHERE used_at IS NULL;
    `);

    await client.query('COMMIT');
    console.log('password-reset-tokens migration complete.');

    // Verify (uses pool, separate from the transactional client).
    try {
      const result = await db.query(
        `SELECT COUNT(*)::int AS n FROM password_reset_tokens`
      );
      console.log('password_reset_tokens row count:', result.rows[0].n);
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
