// CLI: bootstrap or promote an admin user.
//   node src/scripts/create-admin.js <email> <password> [--promote]
//
// If the user exists, promotes them to admin (sets role='admin', tier='enterprise').
// If the user does not yet exist, creates a new admin user with role='admin'.

const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function createOrPromoteAdmin(email, password) {
  if (!email || !password) {
    console.error('Usage: node src/scripts/create-admin.js <email> <password>');
    process.exit(1);
  }

  try {
    const existing = await db.query(
      'SELECT id, role, subscription_tier FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      const result = await db.query(
        `UPDATE users
         SET role = 'admin',
             subscription_tier = 'enterprise',
             verified_at = COALESCE(verified_at, NOW())
         WHERE email = $1
         RETURNING id, email, role, subscription_tier, verified_at`,
        [email]
      );
      console.log(`Promoted ${email} to admin.`, result.rows[0]);
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // verified_at is stamped at admin creation so /api/auth/login never
    // bounces the operator with "Email not verified" on the very first
    // password login. Phases 23/24 keep verified_admins facing the same
    // /verify-email hurdle as any other user, but the admin bootstrap
    // is a privileged-operator CLI — it skips that step on purpose.
    const result = await db.query(
      `INSERT INTO users (email, password_hash, role, subscription_tier, verified_at)
       VALUES ($1, $2, 'admin', 'enterprise', NOW())
       RETURNING id, email, role, subscription_tier, verified_at`,
      [email, passwordHash]
    );
    console.log(`Created admin ${email} (verified).`, result.rows[0]);
    process.exit(0);
  } catch (error) {
    console.error('Error creating admin:', error);
    process.exit(1);
  }
}

const [, , email, password] = process.argv;
createOrPromoteAdmin(email, password);
