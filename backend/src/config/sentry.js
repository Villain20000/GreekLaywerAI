// Optional Sentry error/performance reporting for the backend.
//
// Importing this module never touches the network and never throws: the SDK
// is only initialized when SENTRY_DSN is set, so tests and local development
// stay hermetic. Call initSentry() once during startup.

const Sentry = require('@sentry/node');

let initialized = false;

function tracesSampleRate(raw) {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(parsed, 0), 1);
}

function initSentry() {
  if (initialized) return true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  try {
    Sentry.init({
      dsn,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: tracesSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
      sendDefaultPii: false
    });
    initialized = true;
    return true;
  } catch (err) {
    // A misconfigured SDK must never prevent the server from booting.
    console.error(`[sentry] initialization failed: ${err && err.message}`);
    return false;
  }
}

function captureException(error) {
  if (!initialized) return false;

  try {
    Sentry.captureException(error);
    return true;
  } catch (err) {
    // Error reporting is best-effort; never mask the original failure.
    return false;
  }
}

module.exports = { initSentry, captureException };
