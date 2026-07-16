// One-shot migration: add users.role column with backfill from subscription_tier.
// Safe to re-run (uses IF NOT EXISTS / conname guards).
const db = require('../config/db');

async function migrate() {
  console.log('Starting RBAC migration: adding users.role...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1. Add role column nullable if missing
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50);');

    // 2. Backfill: enterprise tier -> enterprise role, anything else -> user.
    //    Admins (if any) stay as 'admin' (handled manually via CLI script).
    await client.query(
      `UPDATE users
       SET role = CASE
         WHEN subscription_tier = 'enterprise' THEN 'enterprise'
         WHEN subscription_tier = 'admin' THEN 'admin'
         ELSE 'user'
       END
       WHERE role IS NULL;`
    );

    // 3. Enforce default + NOT NULL
    await client.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'user';`);
    await client.query(`ALTER TABLE users ALTER COLUMN role SET NOT NULL;`);

    // 4. Add CHECK constraint, idempotent
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_role_check
            CHECK (role IN ('user', 'admin', 'enterprise'));
        END IF;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('RBAC migration complete.');

    // Verify (uses pool, separate from transactional client)
    try {
      const result = await db.query(
        `SELECT role, COUNT(*)::int AS n FROM users GROUP BY role ORDER BY role;`
      );
      console.log('Role distribution:', result.rows);
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
