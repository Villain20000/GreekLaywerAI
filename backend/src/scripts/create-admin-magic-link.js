// CLI: mint a short-lived admin "magic-link" URL.
//   node src/scripts/create-admin-magic-link.js <email> [ttlMinutes]
//
// Prints `http://localhost:4200/admin-login?token=<jwt>` to stdout. Open
// it in a browser to land signed in at /admin without typing a password.
//
// Hard gate (mirrored from /api/auth/admin-magic-link/redeem):
//   In production (NODE_ENV=production), refuses to mint a link unless
//   ADMIN_MAGIC_LINK_ENABLED=true is set explicitly. This keeps the dev
//   shortcut disabled by default for prod deployments.

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { normalizeRole } = require('../middlewares/authMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';
const DEFAULT_TTL_MIN = 5;
const MAX_TTL_MIN = 60;
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4200';

async function main() {
  const email = process.argv[2];
  const ttlMin = Number(process.argv[3]) || DEFAULT_TTL_MIN;

  if (!email) {
    console.error(
      'Usage: node src/scripts/create-admin-magic-link.js <email> [ttlMinutes]'
    );
    process.exit(1);
  }
  if (!Number.isFinite(ttlMin) || ttlMin <= 0 || ttlMin > MAX_TTL_MIN) {
    console.error(`ttlMinutes must be a positive integer ≤ ${MAX_TTL_MIN}`);
    process.exit(1);
  }

  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ADMIN_MAGIC_LINK_ENABLED !== 'true'
  ) {
    console.error(
      '[create-admin-magic-link] Refusing to mint a magic link in production.\n' +
      'Set ADMIN_MAGIC_LINK_ENABLED=true to opt in.'
    );
    process.exit(2);
  }

  try {
    const result = await db.query(
      'SELECT id, email, role, subscription_tier FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      console.error(`User not found: ${email}`);
      process.exit(1);
    }
    const user = result.rows[0];
    const role = normalizeRole(user.role, user.subscription_tier);
    if (role !== 'admin') {
      console.error(
        `User ${email} is not an admin ` +
        `(role=${user.role}, tier=${user.subscription_tier}).\n` +
        'Run create-admin.js first to promote, then re-run this script.'
      );
      process.exit(1);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, kind: 'admin_magic' },
      JWT_SECRET,
      { expiresIn: `${ttlMin}m` }
    );
    const url = `${APP_BASE_URL}/admin-login?token=${encodeURIComponent(token)}`;

    console.log('\n=== ADMIN MAGIC LINK ===');
    console.log(`Email:  ${user.email}`);
    console.log(`TTL:    ${ttlMin} minute(s)`);
    console.log(`URL:    ${url}`);
    console.log('=======================\n');
    console.log('Open the URL above in your browser to land signed in at /admin.');
    console.log('NOTES:');
    console.log('  • Within the TTL window the same bearer can be redeemed');
    console.log('    more than once; each redemption bumps users.token_version');
    console.log('    and invalidates any other live session JWTs for this admin.');
    console.log('  • The redeem atomically folds Phase 24 email verification in:');
    console.log('    if the admin\'s verified_at is NULL, it\'s stamped to NOW()');
    console.log('    in the same UPDATE, so a later /login via password also');
    console.log('    succeeds. Already-verified admins are unaffected.');
    console.log('  • The URL is a bearer credential — treat it like a password.');
    console.log('    Anyone who reads it before the TTL elapses can log in.');
    process.exit(0);
  } catch (e) {
    console.error('Error minting magic link:', e);
    process.exit(1);
  }
}

main();
