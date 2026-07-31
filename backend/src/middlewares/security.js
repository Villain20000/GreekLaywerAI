// Phase 29: Security hardening middleware.
//
// 1. securityHeaders: defense-in-depth headers applied to every response.
// 2. csrfProtection: double-submit-token CSRF check for state-changing
//    requests that rely on COOKIE-based auth. NomosAI authenticates with
//    JWT Bearer tokens (no cookies), so the primary attack surface is
//    already CSRF-immune; this layer exists for defense-in-depth in case a
//    cookie-based auth path (e.g. an admin session cookie) is ever added.

const crypto = require('crypto');

const CSRF_COOKIE = 'nomos_csrf';

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

/**
 * CSRF protection (double-submit cookie pattern).
 *
 * - GET / HEAD / OPTIONS are never checked.
 * - Requests carrying a Bearer token are never checked (JWT auth is
 *   CSRF-immune — the browser can't forge the Authorization header).
 * - Requests with NO cookies at all are never checked.
 * - Only when cookies are present on a state-changing request do we
 *   require the `X-CSRF-Token` header to match the cookie value.
 *
 * GET handlers may call issueCsrfToken(req, res) to mint the cookie.
 */
function csrfProtection(req, res, next) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const authHeader = req.header('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) return next();

  const hasCookies = req.headers.cookie !== undefined && req.headers.cookie !== '';
  if (!hasCookies) return next();

  const cookieToken = (req.headers.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`)) || [])[1];
  const headerToken = req.header('X-CSRF-Token');

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }
  return next();
}

function issueCsrfToken(req, res) {
  const existing = (req.headers.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`)) || [])[1];
  const token = existing || crypto.randomBytes(24).toString('hex');
  if (!existing) {
    res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
  }
  return token;
}

module.exports = { securityHeaders, csrfProtection, issueCsrfToken };
