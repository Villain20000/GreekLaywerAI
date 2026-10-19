const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { getSecret } = require('../config/secrets');

const DEFAULT_DEV_SECRET = 'nomos-super-secret-key-development';
const JWT_SECRET = getSecret('JWT_SECRET', DEFAULT_DEV_SECRET);

// Phase 29: fail fast in production if JWT_SECRET is unset or still the
// development default. A production deploy running on the well-known
// default secret is fully compromised (anyone can forge JWTs). The value may
// come from JWT_SECRET or from a mounted JWT_SECRET_FILE.
if (process.env.NODE_ENV === 'production') {
  if (!JWT_SECRET || JWT_SECRET === DEFAULT_DEV_SECRET) {
    throw new Error(
      '[authMiddleware] NODE_ENV=production requires JWT_SECRET to be set to a strong, non-default value. Refusing to boot.'
    );
  }
} else if (!JWT_SECRET || JWT_SECRET === DEFAULT_DEV_SECRET) {
  console.warn(
    '[authMiddleware] WARNING: JWT_SECRET is unset or using the development default. ' +
    'Set JWT_SECRET in your environment before deploying to production.'
  );
}

const ALLOWED_ROLES = ['user', 'admin', 'enterprise'];
const ALLOWED_TIERS = ['basic', 'pro', 'enterprise'];

/**
 * Map legacy subscription_tier-style "roles" (which the old JWT mistakenly
 * stored in the role claim) onto the modern RBAC roles so that tokens issued
 * before the migration don't all-of-a-sudden hit 403.
 */
function normalizeRole(role, tier) {
  if (role === 'enterprise') return 'enterprise';
  if (role === 'admin') return 'admin';
  if (role === 'user') return 'user';
  if (tier === 'enterprise') return 'enterprise';
  if (tier === 'admin') return 'admin';
  return 'user';
}

/**
 * Phase 22: live-token auth middleware.
 *
 * 1. Verify the JWT signature (cheap, sync — `jwt.verify` is sync).
 * 2. SELECT id, email, role, subscription_tier, created_at, token_version,
 *    verified_at FROM users WHERE id = $1.
 * 3. Compare `dbUser.token_version` against `decoded.tv`. Mismatch → 401
 *    because the credential was rotated (e.g. via /change-password, which
 *    bumps token_version by 1 in the same UPDATE).
 * 4. Populate req.user from the LIVE row, not the JWT body, so that admin
 *    role-patches AND email verification take effect on the next
 *    authenticated request without forcing a re-login.
 *
 * Trade-offs:
 *  - +1 SELECT per authenticated request. Acceptable for MVP scale.
 *    (At higher traffic this should be cached in Redis with short TTL.)
 *  - Side benefit: `/me` no longer needs its own SELECT — `req.user` already
 *    carries email, role, tier, created_at, verified_at.
 *  - Phase 24 supplement: `verified_at` is included in the projection AND
 *    on req.user.verifiedAt so /me (and any other route reaching through
 *    req.user) reflects verification state for already-open tabs on the
 *    next authenticated round-trip, without requiring a forced
 *    logout/login. The JWT itself does not encode verified_at (it's a
 *    mutable timestamp, and Phase 22 already invalidates tokens via tv
 *    so we don't need to bake it into the JWT body).
 */
const authMiddleware = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  let dbUser;
  try {
    const result = await db.query(
      `SELECT id, email, role, subscription_tier, created_at, token_version, verified_at
       FROM users WHERE id = $1`,
      [decoded.id]
    );
    if (result.rows.length === 0) {
      // JWT pointed at a deleted user.
      return res.status(401).json({ error: 'User not found' });
    }
    dbUser = result.rows[0];
  } catch (err) {
    console.error('authMiddleware DB error:', err);
    return res.status(500).json({ error: 'Server error' });
  }

  // Reject stale tokens. `decoded.tv` is `undefined` for tokens issued
  // before Phase 22 — first request after deploy 401s and the user re-logs.
  if (dbUser.token_version !== decoded.tv) {
    return res.status(401).json({ error: 'Session invalidated; please log in again.' });
  }

  // Normalize role against the LIVE tier so legacy tokens claiming "enterprise"
  // via the role field keep working, AND so live role PATCHes win.
  req.user = {
    id: dbUser.id,
    email: dbUser.email,
    role: normalizeRole(dbUser.role, dbUser.subscription_tier),
    subscription_tier: dbUser.subscription_tier,
    created_at: dbUser.created_at,
    tokenVersion: dbUser.token_version,
    /**
     * Phase 24: ISO timestamp from `users.verified_at`. NULL means the
     * account has not yet consumed a /verify-email link; /api/auth/login
     * refuses to mint a JWT for unverified accounts, so by the time a
     * request reaches authMiddleware the value is always non-null in
     * practice — but we still propagate the raw value (not coerced to
     * a boolean) so /me can show a precise timestamp and so defensive
     * code can detect the (impossible-today) edge case should future
     * flows ever pre-mint verification-pending tokens.
     *
     * Map to camelCase `verifiedAt` to stay consistent with the
     * `tokenVersion` rename pattern; downstream handlers (notably /me)
     * re-snake_case it for the response body and storage.
     */
    verifiedAt: dbUser.verified_at
  };
  return next();
};

/**
 * Factory: gate a route to a list of allowed roles.
 * Usage: router.post('/x', rbacMiddleware(['admin']), handler)
 */
const rbacMiddleware = (roles = []) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }
    next();
  };
};

module.exports = {
  authMiddleware,
  rbacMiddleware,
  normalizeRole,
  ALLOWED_ROLES,
  ALLOWED_TIERS
};
