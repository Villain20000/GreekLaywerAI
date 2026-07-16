const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const { authMiddleware, normalizeRole } = require('../middlewares/authMiddleware');
const { createRateLimiters } = require('../middlewares/rateLimiters');
const { sendPasswordReset, sendEmailVerification } = require('../services/emailService');

const JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development';
const MIN_PASSWORD_LENGTH = 8;
const RESET_TOKEN_EXPIRY_HOURS = 1;
/**
 * Phase 24: verification tokens live longer than reset tokens because the
 * user may not have email-clients open during the registration flow (e.g.
 * mobile signup, week-old email). 24h is the de-facto industry default
 * (Stripe, Auth0, etc.). Anything shorter and legitimate users start
 * bouncing out mid-session.
 */
const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;

/**
 * Sign a JWT whose role claim reflects users.role (with legacy-compat).
 *
 * Phase 22: also embeds `tv` (= user.token_version). authMiddleware
 * compares this against the live DB value; bump-and-rotate on
 * /change-password invalidates every older token in one shot.
 */
function signUserToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: normalizeRole(user.role, user.subscription_tier),
      tier: user.subscription_tier || 'basic',
      tv: user.token_version
    },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
}

/**
 * Build the /api/auth router. Accepts an injected `limiters` map (with
 * register / login / changePasswordPreAuth / changePasswordPerAccount /
 * changePasswordPerAccountDaily entries) so tests can supply aggressive
 * limits while production uses the env-aware defaults from
 * createRateLimiters().
 */
function buildAuthRouter(options = {}) {
  const router = express.Router();
  const limiters = options.limiters || createRateLimiters();

  /**
   * Phase 24: Public registration. Role is always forced to 'user' regardless
   * of any client-supplied value. The only exception: a client-supplied role
   * of 'admin' is rejected with 403 so users cannot self-promote. The
   * admin-block is evaluated FIRST so even malformed bodies cannot
   * accidentally return 400 for an admin self-registration attempt.
   *
   * Phase 24: registration NO LONGER mints a JWT. Instead, the user row
   * is created with verified_at=NULL, an email_verification_tokens row is
   * inserted, and the plaintext verify-token is mailed. The user receives
   * response `{ ok: true, requires_verification: true, user: {...} }` —
   * no `token` field. /api/auth/login rejects any user where verified_at
   * IS NULL. /api/auth/verify-email is the only path that mints the
   * first JWT for a brand-new account.
   *
   * Implementation note (no db.connect()/BEGIN/COMMIT):
   *   We deliberately use the chain-of-db.query pattern (matching Phase 23
   *   forgot-password) rather than a BEGIN/COMMIT transaction. The race
   *   between concurrent signups of the same email is closed by the
   *   `users.email` UNIQUE constraint — the second INSERT raises and the
   *   route returns 400. The orphan-user window (insert users succeeds,
   *   insert email_verification_tokens fails before this whole block
   *   finishes) is microseconds-wide in practice and is recoverable via
   *   /api/auth/resend-verification, which always returns 200 and inserts
   *   a fresh token row for any unverified user. The simpler chain keeps
   *   the test app's `db.query` mock usable across all register-related
   *   test paths without a parallel `db.connect` mock for the client.
   */
  router.post('/register', limiters.register, async (req, res) => {
    try {
      // Hard block: reject admin self-promotion before any other validation.
      if (req.body && req.body.role === 'admin') {
        return res.status(403).json({ error: 'Cannot self-register as admin' });
      }

      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({
          error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
        });
      }

      const normalizedEmail = String(email).trim().toLowerCase();

      const existing = await db.query(
        'SELECT 1 FROM users WHERE email = $1',
        [normalizedEmail]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const salt = await bcrypt.genSalt(12);
      const passwordHash = await bcrypt.hash(password, salt);

      // verified_at is left NULL on purpose — /login rejects unverified users.
      // `users.email` UNIQUE catches concurrent duplicate signups; the
      // INSERT below is the source-of-truth atomic boundary.
      const userResult = await db.query(
        `INSERT INTO users (email, password_hash, role, subscription_tier)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, subscription_tier, token_version`,
        [normalizedEmail, passwordHash, 'user', 'basic']
      );
      const newUser = userResult.rows[0];

      // Build the verify-token (32-byte hex → sha256 hash stored; plaintext
      // embedded in the email link). Same shape as Phase 23 reset.
      const plaintextToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto
        .createHash('sha256')
        .update(plaintextToken)
        .digest('hex');
      const expiresAt = new Date(
        Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
      );

      await db.query(
        `INSERT INTO email_verification_tokens
           (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [newUser.id, tokenHash, expiresAt]
      );

      // Fire-and-forget. We deliberately do NOT await this promise — the
      // user has already had a successful register by the time the response
      // goes out, and SMTP failures shouldn't propagate as 5xx.
      sendEmailVerification(normalizedEmail, plaintextToken)
        .catch((err) => console.error('[VERIFY EMAIL] send failed:', err.message));

      return res.json({
        ok: true,
        requires_verification: true,
        user: {
          id: newUser.id,
          email: newUser.email,
          role: newUser.role,
          subscription_tier: newUser.subscription_tier,
          token_version: newUser.token_version,
          verified_at: null
        }
      });
    } catch (error) {
      // UNIQUE violation on users.email (\"duplicate key\") under concurrent
      // signup races surfaces here. Translate to 400 with the same copy
      // the synchronous duplicate-check returns.
      if (error && error.code === '23505' && error.constraint === 'users_email_key') {
        return res.status(400).json({ error: 'User already exists' });
      }
      console.error('Registration Error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  /**
   * Phase 24: Login. Role comes from users.role. Rejects unverified
   * accounts with a 400 whose message instructs the user to check their
   * inbox (and includes a "resend verification" affordance upstream in
   * the LoginComponent). All error messages are surfaced to the client
   * without enumeration risk because the caller already supplied a known
   * email + correct password; we are NOT in the
   * "should I tell the user the account exists?" failure mode that
   * requires timing-jitter.
   */
  router.post('/login', limiters.login, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const result = await db.query(
        `SELECT id, email, password_hash, role, subscription_tier, token_version, verified_at
         FROM users WHERE email = $1`,
        [email]
      );
      if (result.rows.length === 0) {
        // Generic "Invalid credentials" — same as for wrong-password on a
        // verified account — so we don't leak whether the email exists.
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      const user = result.rows[0];
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      // Phase 24: unverified accounts cannot mint JWTs. The 400 message is
      // a static string the LoginComponent pattern-matches on to surface
      // a "Resend verification email" button. Do NOT change this copy
      // without updating LoginComponent's unverified-state detector.
      if (user.verified_at === null) {
        return res.status(400).json({
          error: 'Email not verified. Check your inbox for the verification link.'
        });
      }

      const token = signUserToken(user);

      res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          subscription_tier: user.subscription_tier,
          token_version: user.token_version,
          verified_at: user.verified_at
        }
      });
    } catch (error) {
      console.error('Login Error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  /**
   * Return the authenticated user from the JWT.
   *
   * Phase 22: authMiddleware already runs a live SELECT for
   * id/email/role/subscription_tier/created_at/token_version, so /me no
   * longer needs its own DB round-trip. Freshness comes from authMiddleware,
   * not from this handler; admin role PATCHes are reflected here on the next
   * request naturally. If authMiddleware passed, the user exists — the
   * former 404 path is unreachable (authMiddleware 401s on missing user).
   */
  router.get('/me', authMiddleware, async (req, res) => {
    try {
      res.json({
        user: {
          id: req.user.id,
          email: req.user.email,
          role: req.user.role,
          subscription_tier: req.user.subscription_tier,
          created_at: req.user.created_at,
          token_version: req.user.tokenVersion,
          /**
           * Phase 24 supplement: propagate the live `users.verified_at`
           * onto `/me` so an already-open tab that re-fetches /me (e.g.
           * the cold-start `AuthService.refreshFromServer` round-trip,
           * or any manual `/me` poll) reflects verification state without
           * a forced logout/login. Combined with the authMiddleware SELECT
           * projection (which now includes `verified_at`), every other
           * tab/device whose JWT is still valid also picks up the new
           * value on the next authenticated request.
           */
          verified_at: req.user.verifiedAt
        }
      });
    } catch (error) {
      console.error('Auth /me error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

  /**
   * Rotate the authenticated user's own password.
   *
   * Requires a valid JWT (req.user.id is trusted, not the request body).
   * Body: { currentPassword: string, newPassword: string }.
   *
   * Security posture:
   *  - Re-verifies the current password via bcrypt.compare so a stolen JWT
   *    alone (without the current password) cannot rotate the credential.
   *  - Refuses passwords shorter than MIN_PASSWORD_LENGTH (same threshold
   *    as /register).
   *  - Refuses no-op rotation (new password identical to current).
   *  - Returns a generic 400 — does NOT leak whether the current password
   *    was wrong versus other validation failures — to avoid giving a brute-
   *    forcer a signal. (The route is JWT-gated so this is mostly defensive.)
   *
   * Rate limiting:
   *  - Pre-auth per-IP layer (changePasswordPreAuth) bounds the cost of an
   *    attacker spamming with forged tokens (authMiddleware would 401, but
   *    each 401 is still bcrypt+JWT verify CPU).
   *  - Post-auth per-account 5/min + 20/day (stacked) ensures even with a
   *    stolen JWT an attacker can't brute-force faster than the daily cap.
   */
  router.post(
    '/change-password',
    limiters.changePasswordPreAuth,
    authMiddleware,
    limiters.changePasswordPerAccount,
    limiters.changePasswordPerAccountDaily,
    async (req, res) => {
      try {
        const { currentPassword, newPassword } = req.body || {};

        if (
          typeof currentPassword !== 'string' ||
          typeof newPassword !== 'string' ||
          currentPassword.length === 0 ||
          newPassword.length === 0
        ) {
          return res.status(400).json({ error: 'Current and new password required' });
        }

        if (newPassword.length < MIN_PASSWORD_LENGTH) {
          return res.status(400).json({
            error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
          });
        }

        const lookup = await db.query(
          'SELECT id, password_hash FROM users WHERE id = $1',
          [req.user.id]
        );
        if (lookup.rows.length === 0) {
          // JWT pointed at a deleted user.
          return res.status(401).json({ error: 'User not found' });
        }
        const stored = lookup.rows[0].password_hash;

        const matches = await bcrypt.compare(currentPassword, stored);
        if (!matches) {
          return res.status(400).json({ error: 'Password change failed' });
        }

        // Defensive: don't silently accept a no-op rotation.
        if (await bcrypt.compare(newPassword, stored)) {
          return res.status(400).json({ error: 'Password change failed' });
        }

        const salt = await bcrypt.genSalt(12);
        const newHash = await bcrypt.hash(newPassword, salt);

        // Compare-and-set: only UPDATE if the stored hash hasn't changed since we
        // SELECTed it. If another request already rotated the password while we
        // were bcrypting, the UPDATE affects 0 rows and we return a generic
        // 409 — never revealing which field failed. This prevents a concurrent
        // rotation from silently clobbering the other.
        //
        // Phase 22: bump `token_version` in the SAME UPDATE so every JWT
        // signed with the previous tv is invalidated atomically with the
        // password rotation. RETURNING includes the new token_version so
        // we can mint a freshly-signed token in the response.
        const updateResult = await db.query(
          `UPDATE users
           SET password_hash = $1,
               token_version = token_version + 1
           WHERE id = $2 AND password_hash = $3
           RETURNING id, email, role, subscription_tier, token_version`,
          [newHash, req.user.id, stored]
        );

        if (!updateResult.rowCount || updateResult.rowCount === 0) {
          return res.status(409).json({ error: 'Password change failed' });
        }

        const freshUser = updateResult.rows[0];
        // Mint a token signed with the NEW token_version so the same user
        // doesn't have to re-login; authMiddleware will accept it. Any old
        // JWT they were holding fails the strict tv equality check.
        const newToken = signUserToken(freshUser);

        res.json({
          ok: true,
          token: newToken,
          user: {
            id: freshUser.id,
            email: freshUser.email,
            role: freshUser.role,
            subscription_tier: freshUser.subscription_tier,
            token_version: freshUser.token_version
          }
        });
      } catch (error) {
        console.error('Change-password error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  /**
   * Phase 23: Forgot-password.
   *
   * Body: { email: string }. Public route.
   *
   * Always returns 200 with `{ ok: true }` regardless of whether the email
   * exists. Side-effects (token row insert, email send) only fire when the
   * user exists — so attackers can't enumerate accounts via 200-vs-404 timing
   * or response-body differences. A short random jitter (50-200 ms) further
   * smooths response latency so a high-resolution timer can't distinguish.
   *
   * Rate limits (stacked): per-IP 5/min + 20/hr (block spam bursts AND slow
   * burn), per-email 3/hr (stop an attacker from spamming one address).
   */
  router.post(
    '/forgot-password',
    limiters.forgotPasswordIpMin,
    limiters.forgotPasswordIpHour,
    limiters.forgotPasswordEmail,
    async (req, res) => {
      try {
        const { email } = req.body || {};

        // Defensive basic-shape validation BEFORE the always-200 path. We
        // still return 200 on malformed input because that's also a
        // defensive move against enumeration (an attacker probing email
        // formats should not get a different response code). Document the
        // tradeoff in a comment for future maintainers.
        //
        // Length clamp (RFC 5321 caps the local+domain at 254; we cap at
        // 320 to leave room for any future header prepending by the email
        // provider). Without this, `req.body.email` of arbitrary size
        // would be passed straight into the per-email rate-limit key
        // generator, where Redis would happily store a megabyte-sized
        // key. Clamp here before anything reads it.
        if (typeof email !== 'string' ||
            email.length === 0 ||
            email.length > 320 ||
            !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          // Even if the body is malformed, return the same generic 200 so
          // an attacker can't probe the validator (timing or otherwise).
          await jitter();
          return res.status(200).json({ ok: true });
        }

        const lookup = await db.query(
          'SELECT id FROM users WHERE email = $1',
          [email.trim().toLowerCase()]
        );

        if (lookup.rows.length > 0) {
          const userId = lookup.rows[0].id;
          const plaintextToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto
            .createHash('sha256')
            .update(plaintextToken)
            .digest('hex');
          const expiresAt = new Date(
            Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
          );

          await db.query(
            `INSERT INTO password_reset_tokens
               (user_id, token_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [userId, tokenHash, expiresAt]
          );

          // Fire-and-forget the email send. We deliberately do NOT
          // surface errors to the user — a failed SMTP delivery should
          // not reveal "the email exists" timing. Logged inside the
          // service for ops visibility.
          sendPasswordReset(email.trim().toLowerCase(), plaintextToken)
            .catch((err) => console.error('[RESET EMAIL] send failed:', err.message));
        }

        await jitter();
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('Forgot-password error:', error);
        // Always 200 on success-pathway failures too — no enumeration signal.
        await jitter();
        res.status(200).json({ ok: true });
      }
    }
  );

  /**
   * Phase 23: Reset-password.
   *
   * Body: { token: string, newPassword: string }. Public route; the token
   * itself is the bearer credential, looked up by SHA-256 hash.
   *
   * Security:
   *  - Token existence + freshness (expires_at > NOW()) + unused (used_at IS NULL)
   *    all checked at SELECT time.
   *  - Compare-and-set UPDATE on `used_at IS NULL` ensures two concurrent resets
   *    for the same token can't both succeed.
   *  - UPDATE bumps users.token_version in the same statement, invalidating
   *    every prior JWT for that user (Phase 22 mechanism).
   *  - Returns a freshly-minted JWT so the user is automatically signed in
   *    after the reset completes (matches /change-password's UX).
   *  - newPassword must be at least MIN_PASSWORD_LENGTH — same threshold as
   *    /register and /change-password (the user explicitly requested this).
   *
   * Returns 400 with the same generic "Invalid or expired reset link" message
   * for missing / consumed / expired token, so attackers can't distinguish.
   */
  router.post(
    '/reset-password',
    limiters.resetPasswordIp,
    async (req, res) => {
      try {
        const { token, newPassword } = req.body || {};

        if (
          typeof token !== 'string' ||
          typeof newPassword !== 'string' ||
          newPassword.length < MIN_PASSWORD_LENGTH
        ) {
          // Generic 400 — no signal about which check failed.
          return res.status(400).json({ error: 'Invalid or expired reset link' });
        }

        // Defensive: token must be hex of expected length (64 hex chars from
        // crypto.randomBytes(32)). Anything else short-circuits before DB.
        if (!/^[a-f0-9]{64}$/i.test(token)) {
          return res.status(400).json({ error: 'Invalid or expired reset link' });
        }

        const tokenHash = crypto
          .createHash('sha256')
          .update(token)
          .digest('hex');

        // Phase 22 atomicity: BEGIN a tx so the token-mark + password-rotation
        // either both happen or neither does. Otherwise a crash between the
        // two would leave the token "consumed" without changing the password.
        const client = await db.connect();
        try {
          await client.query('BEGIN');

          const lookupRes = await client.query(
            `SELECT id, user_id
             FROM password_reset_tokens
             WHERE token_hash = $1
               AND used_at IS NULL
               AND expires_at > NOW()`,
            [tokenHash]
          );
          if (lookupRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired reset link' });
          }

          const tokenRowId = lookupRes.rows[0].id;
          const userId = lookupRes.rows[0].user_id;

          // Compare-and-set consume: only flip used_at if it's still NULL.
          const consumeRes = await client.query(
            `UPDATE password_reset_tokens
             SET used_at = NOW()
             WHERE id = $1 AND used_at IS NULL
             RETURNING id`,
            [tokenRowId]
          );
          if (!consumeRes.rowCount || consumeRes.rowCount === 0) {
            // Concurrent reset consumed the token between our SELECT and
            // this UPDATE.
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired reset link' });
          }

          const salt = await bcrypt.genSalt(12);
          const newHash = await bcrypt.hash(newPassword, salt);

          // Phase 22: bump token_version atomically with the hash rotation.
          // Old tokens become invalid immediately; the freshly-minted JWT
          // below carries the new tv and authMiddleware accepts it.
          const userUpdate = await client.query(
            `UPDATE users
             SET password_hash = $1,
                 token_version = token_version + 1
             WHERE id = $2
             RETURNING id, email, role, subscription_tier, token_version`,
            [newHash, userId]
          );
          if (!userUpdate.rowCount) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'Server error' });
          }

          const freshUser = userUpdate.rows[0];
          const newToken = signUserToken(freshUser);

          await client.query('COMMIT');

          return res.json({
            ok: true,
            token: newToken,
            user: {
              id: freshUser.id,
              email: freshUser.email,
              role: freshUser.role,
              subscription_tier: freshUser.subscription_tier,
              token_version: freshUser.token_version
            }
          });
        } catch (innerErr) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
          throw innerErr;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Reset-password error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  /**
   * Phase 24: Verify-email.
   *
   * Body: { token: string }. Public route; the token IS the bearer credential,
   * exactly like /reset-password.
   *
   * Atomicity:
   *   BEGIN / SELECT email_verification_tokens WHERE token_hash = $1 AND
   *   used_at IS NULL AND expires_at > NOW() / UPDATE used_at (compare-and-set)
   *   / UPDATE users SET verified_at = NOW(), token_version = token_version + 1
   *   / COMMIT.
   *
   *   verified_at and token_version move together — verification is a security
   *   boundary, so we bump tv atomically. Any pre-verification JWT (there are
   *   none today because /register doesn't mint one, but it's defensive in
   *   case future flows do) becomes invalid immediately on verify.
   *
   * Returns:
   *   - 200 with `{ok, token, user}` matching the format of /reset-password.
   *     The token here is the FIRST JWT issued for this user; signed with the
   *     freshly-bumped token_version. authMiddleware accepts it on subsequent
   *     requests.
   *   - 400 with generic "Invalid or expired verification link" for missing /
   *     consumed / expired tokens (mirrors /reset-password's UX).
   */
  router.post(
    '/verify-email',
    limiters.verifyEmailIp,
    async (req, res) => {
      try {
        const { token } = req.body || {};

        if (typeof token !== 'string') {
          return res.status(400).json({ error: 'Invalid or expired verification link' });
        }
        if (!/^[a-f0-9]{64}$/i.test(token)) {
          return res.status(400).json({ error: 'Invalid or expired verification link' });
        }

        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        const client = await db.connect();
        try {
          await client.query('BEGIN');

          const lookupRes = await client.query(
            `SELECT id, user_id
             FROM email_verification_tokens
             WHERE token_hash = $1
               AND used_at IS NULL
               AND expires_at > NOW()`,
            [tokenHash]
          );
          if (lookupRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired verification link' });
          }

          const tokenRowId = lookupRes.rows[0].id;
          const userId = lookupRes.rows[0].user_id;

          // Compare-and-set consume (single-use enforced at DB layer by the
          // partial unique index `email_verification_tokens_unused_hash_uidx`).
          const consumeRes = await client.query(
            `UPDATE email_verification_tokens
             SET used_at = NOW()
             WHERE id = $1 AND used_at IS NULL
             RETURNING id`,
            [tokenRowId]
          );
          if (!consumeRes.rowCount || consumeRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid or expired verification link' });
          }

          // Atomic verify + tv bump. verified_at=NOW() marks the user active
          // for /login; token_version+1 invalidates any prior JWT that may
          // somehow have been issued for this user (none today, but it's
          // future-proof). RETURNING includes verified_at so we can show it
          // in the response.
          const userUpdate = await client.query(
            `UPDATE users
             SET verified_at = NOW(),
                 token_version = token_version + 1
             WHERE id = $1
             RETURNING id, email, role, subscription_tier, token_version, verified_at`,
            [userId]
          );
          if (!userUpdate.rowCount) {
            await client.query('ROLLBACK');
            return res.status(500).json({ error: 'Server error' });
          }

          const freshUser = userUpdate.rows[0];
          const newToken = signUserToken(freshUser);

          await client.query('COMMIT');

          return res.json({
            ok: true,
            token: newToken,
            user: {
              id: freshUser.id,
              email: freshUser.email,
              role: freshUser.role,
              subscription_tier: freshUser.subscription_tier,
              token_version: freshUser.token_version,
              verified_at: freshUser.verified_at
            }
          });
        } catch (innerErr) {
          try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
          throw innerErr;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error('Verify-email error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  /**
   * Phase 24: Resend-verification.
   *
   * Body: { email: string }. Public route. Always returns 200 with
   * `{ ok: true }` regardless of email existence — same anti-enumeration
   * posture as /forgot-password. 50–200ms jitter smooths response-time
   * differences between "email exists, send" and "email does not exist,
   * skip".
   *
   * Side effects when the user exists AND verified_at IS NULL:
   *   - Insert a fresh email_verification_tokens row with 24h expiry.
   *   - Fire-and-forget sendEmailVerification with the new plaintext token.
   *
   * We do NOT re-send if the user is already verified_at != NULL (the
   * account is already active; spam-resending would be confusing UX). The
   * outer 200 is preserved regardless so an attacker can't tell apart
   * "user never existed" from "user exists and is verified".
   */
  router.post(
    '/resend-verification',
    limiters.resendVerificationIp,
    limiters.resendVerificationEmail,
    async (req, res) => {
      try {
        const { email } = req.body || {};

        if (typeof email !== 'string' ||
            email.length === 0 ||
            email.length > 320 ||
            !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          await jitter();
          return res.status(200).json({ ok: true });
        }

        const lookup = await db.query(
          'SELECT id, verified_at FROM users WHERE email = $1',
          [email.trim().toLowerCase()]
        );

        if (lookup.rows.length > 0 && lookup.rows[0].verified_at === null) {
          const userId = lookup.rows[0].id;
          const plaintextToken = crypto.randomBytes(32).toString('hex');
          const tokenHash = crypto
            .createHash('sha256')
            .update(plaintextToken)
            .digest('hex');
          const expiresAt = new Date(
            Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
          );

          await db.query(
            `INSERT INTO email_verification_tokens
               (user_id, token_hash, expires_at)
             VALUES ($1, $2, $3)`,
            [userId, tokenHash, expiresAt]
          );

          sendEmailVerification(email.trim().toLowerCase(), plaintextToken)
            .catch((err) => console.error('[VERIFY EMAIL] resend failed:', err.message));
        }

        await jitter();
        return res.status(200).json({ ok: true });
      } catch (error) {
        console.error('Resend-verification error:', error);
        await jitter();
        res.status(200).json({ ok: true });
      }
    }
  );

  /**
   * Phase 25 (admin bypass): redeem an admin-magic-link JWT.
   *
   * Body: { token: string }. Public route; the token IS the bearer credential.
   * The CLI `scripts/create-admin-magic-link.js` signs a short-lived JWT
   * (default 5 min) with claims { id, email, kind: 'admin_magic', iat, exp }.
   * The operator copies the printed URL into a browser; MagicLoginComponent
   * POSTs the token here, we redeem it for a session JWT, the frontend
   * swaps it into localStorage and routes to /admin.
   *
   * Security posture:
   *  - Hard gate: if NODE_ENV === 'production' AND
   *    ADMIN_MAGIC_LINK_ENABLED !== 'true' the route returns 404. This
   *    mirrors emailService.assertSafeSend()'s posture — production
   *    deployments fail closed unless the operator explicitly opts in.
   *  - Signature + exp are both enforced by jwt.verify (throws on either).
   *  - `kind: 'admin_magic'` claim is mandatory — without it, even a
   *    valid JWT signed with JWT_SECRET for some other purpose cannot
   *    reach this handler's success path.
   *  - User's admin role is re-read from the LIVE users table, not
   *    inferred from the token, so demoting an admin between mint and
   *    redeem blocks the redemption.
   *  - Bumps users.token_version on success (Phase 22 mechanism). This
   *    invalidates any other live session JWTs the admin may be holding
   *    in other tabs/devices; acceptable for a dev shortcut but operationally
   *    worth noting.
   *
   * Trade-offs (deliberate for a dev feature):
   *  - Within the TTL window the same bearer can be redeemed more than
   *    once. Each redeem mints a fresh session JWT AND bumps tv again.
   *    No DB-backed jti-dedupe table — keeps the dev shortcut lean.
   *    Operators who want stronger bounds should shorten the TTL.
   *  - JWT_SECRET must match between this endpoint and the CLI that
   *    signed the token; both fall back to the same development default.
   *  - URL leaks via Referer / browser history — dev-only. The hard gate
   *    above is what prevents accidental prod exposure.
   *
   * Returns:
   *   - 200 with `{ ok, token, user }` matching the response shape of
   *     /reset-password and /verify-email. Same frontend swap path works.
   *   - 400 generic "Invalid magic link" / "Invalid or expired magic link"
   *     for bad / expired tokens (no enumeration signal — there is no
   *     email lookup on this path).
   *   - 403 if user is no longer admin.
   *   - 404 if the feature is disabled (NODE_ENV=production without opt-in).
   */
  router.post(
    '/admin-magic-link/redeem',
    limiters.verifyEmailIp, // re-use the 20/min per-IP brute-force bucket
    async (req, res) => {
      try {
        if (
          process.env.NODE_ENV === 'production' &&
          process.env.ADMIN_MAGIC_LINK_ENABLED !== 'true'
        ) {
          return res.status(404).json({ error: 'Not found' });
        }

        const { token } = req.body || {};
        if (typeof token !== 'string' || token.length === 0) {
          return res.status(400).json({ error: 'Invalid or expired magic link' });
        }

        let decoded;
        try {
          decoded = jwt.verify(token, JWT_SECRET);
        } catch (_err) {
          // Signature mismatch OR exp elapsed — same 400 as everything else
          // so no oracle distinguishes signature-failure from format-failure.
          return res.status(400).json({ error: 'Invalid or expired magic link' });
        }

        if (decoded.kind !== 'admin_magic') {
          // Reject tokens that are otherwise-valid session JWTs (no `kind`
          // claim) by treating the missing claim the same as a wrong one.
          // Defends against accidental cookie/header cross-flow replay.
          return res.status(400).json({ error: 'Invalid or expired magic link' });
        }

        const lookup = await db.query(
          `SELECT id, email, role, subscription_tier
           FROM users WHERE id = $1`,
          [decoded.id]
        );
        if (lookup.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid or expired magic link' });
        }
        const dbUser = lookup.rows[0];
        const role = normalizeRole(dbUser.role, dbUser.subscription_tier);
        if (role !== 'admin') {
          return res.status(403).json({ error: 'Admin role required' });
        }

        // Phase 22 atomicity + verify-folding:
        //   - Bump tv in the same UPDATE so OTHER live session JWTs for this
        //     admin are invalidated. The freshly-signed session JWT below
        //     carries the new tv, so authMiddleware accepts it on subsequent
        //     requests.
        //   - COALESCE(verified_at, NOW()) folds Phase 24's email-verification
        //     gate into the redeem: an admin who hasn't yet clicked the
        //     /verify-email link is stamped verified here, so a subsequent
        //     /api/auth/login via password also succeeds instead of hitting
        //     the canonical "Email not verified." rejection. If the admin was
        //     ALREADY verified, the COALESCE leaves verified_at unchanged —
        //     no semantic disturbance.
        const updateRes = await db.query(
          `UPDATE users
           SET token_version = token_version + 1,
               verified_at = COALESCE(verified_at, NOW())
           WHERE id = $1
           RETURNING id, email, role, subscription_tier, token_version, verified_at`,
          [dbUser.id]
        );
        if (!updateRes.rowCount) {
          return res.status(500).json({ error: 'Server error' });
        }
        const freshUser = updateRes.rows[0];
        const newToken = signUserToken(freshUser);

        // Operational audit trail — distinct from app logs so SRE can grep.
        // The verified_at timestamp is included so the audit can spot
        // verify-folding events vs. ordinary reissues.
        console.log(
          `[ADMIN-MAGIC-LINK] Redeemed for id=${freshUser.id} ` +
          `email=${freshUser.email} verified_at=${freshUser.verified_at}`
        );

        return res.json({
          ok: true,
          token: newToken,
          user: {
            id: freshUser.id,
            email: freshUser.email,
            role: freshUser.role,
            subscription_tier: freshUser.subscription_tier,
            token_version: freshUser.token_version,
            verified_at: freshUser.verified_at
          }
        });
      } catch (error) {
        console.error('Admin-magic-link redeem error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );

  return router;
}

/**
 * /api/auth/reset-password security note:
 *   Token-ownership verification uses `WHERE token_hash = $1` at SQL level
 *   (not a Node-side `===` comparison), so pg's protocol transfer is the
 *   only oracle. We deliberately do NOT switch to `crypto.timingSafeEqual`
 *   because the comparison happens in the database over the wire already —
 *   adding a second Node-side hash check would double-hash on every request
 *   without a real timing benefit. A reviewer who suggests
 *   `timingSafeEqual` should look here first.
 */

/**
 * Sleep 50-200ms. Used by /forgot-password to smooth response latency so a
 * high-resolution timer can't tell "user exists" from "user not found".
 */
function jitter() {
  const delay = 50 + Math.floor(Math.random() * 150);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// Default singleton for production callers (index.js + test app.js).
const defaultRouter = buildAuthRouter();
module.exports = defaultRouter;
module.exports.buildAuthRouter = buildAuthRouter;
module.exports.default = defaultRouter;
