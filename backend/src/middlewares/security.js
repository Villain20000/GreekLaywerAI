// Phase 29: Security hardening middleware.
//
// securityHeaders: defense-in-depth headers applied to every response.
//
// CSRF note (1-12): a `csrfProtection` double-submit-cookie layer used to live
// here, but it never issued a token (nothing called `issueCsrfToken`) and the
// cookie it generated was `HttpOnly`, so the documented double-submit contract
// could never be satisfied. NomosAI authenticates with JWT Bearer tokens and
// sets no auth cookies, which makes state-changing requests CSRF-immune: a
// cross-site page cannot attach a victim's `Authorization` header. The inert
// layer was removed rather than kept as false assurance. If cookie-based auth
// is ever introduced, implement a real double-submit flow then (a readable,
// non-HttpOnly cookie + matching `X-CSRF-Token` header, minted and verified on
// every state-changing request).

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

module.exports = { securityHeaders };
