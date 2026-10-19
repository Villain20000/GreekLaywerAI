// Phase 15: Data Privacy & Local GDPR Middlewares
// Ensures sensitive legal data does not leak to external APIs and logging is minimized

const { logger } = require('./requestLogger');

const privacyShield = (req, res, next) => {
  // 1. Route the per-request diagnostic through the structured pino logger
  //    instead of console.log. DEBUG keeps it out of production logs by
  //    default; only method + path are recorded (query strings are stripped so
  //    verification/reset tokens can't leak, and bodies/headers are never
  //    touched), so legal context and credentials stay out of the log line.
  logger.debug(
    {
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0]
    },
    'privacy shield: request processed locally'
  );

  // 2. Enforce Headers for no-caching of sensitive legal requests
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  // 3. Mark the request as locally processed
  req.isLocallyProcessed = true;

  next();
};

module.exports = privacyShield;
