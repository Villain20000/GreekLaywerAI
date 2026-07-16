// One-shot migration: add users.token_version column for session invalidation.
//
// Every JWT issued by signUserToken() embeds a `tv` claim equal to the
// user's current token_version. authMiddleware re-reads the live value from
// the DB on each authenticated request; a mismatch (because the user
// rotated their password, which bumps token_version by 1) causes 401.
// Existing rows are backfilled to 1 by the column's DEFAULT, so all tokens
// issued before the migration become invalid exactly once — users will log
// in again post-deploy. Idempotent: ADD COLUMN IF NOT EXISTS.
const db = require('../config/db');

async function migrate() {
  console.log('Starting token-version migration: adding users.token_version...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Add token_version column. Postgres backfills all existing rows to 1
    //    atomically; the locked CREATE TABLE pattern in schema.sql makes this
    //    cheap on small tables.
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1;`
    );

    await client.query('COMMIT');
    console.log('token-version migration complete.');

    // Verify (uses pool, separate from transactional client).
    try {
      const result = await db.query(
        `SELECT token_version, COUNT(*)::int AS n FROM users GROUP BY token_version ORDER BY token_version;`
      );
      console.log('token_version distribution:', result.rows);
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
