// Hermetic test environment.
//
// The suite must behave identically regardless of the developer's ambient
// shell. Three application modules read the environment at import time:
//
//   - `authMiddleware` refuses to boot under NODE_ENV=production without a
//     strong JWT_SECRET, and resolves the signing secret from the env.
//   - `emailService` hard-throws under NODE_ENV=production without SMTP
//     configured, and selects its transport at load time.
//   - `rateLimiters` picks its Redis-backed store at load time when
//     NODE_ENV=production.
//
// Test JWTs are also signed with the development secret (see tests/api.test.js
// and the other suites that hard-code it), so an ambient JWT_SECRET would make
// the server verify with one secret while the tests sign with another.
//
// Pinning both here — once, for every suite — keeps an ambient
// `NODE_ENV=production` or a stray `JWT_SECRET` from changing how the suite
// runs. Individual suites may still override these values after this file
// loads (several already do), which is exactly what they need for the
// production-gate cases.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'nomos-super-secret-key-development';
