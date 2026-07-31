// Phase 29: Structured JSON logging + per-request correlation IDs.
//
// Every request gets a UUID request ID (passed through from X-Request-ID
// when present), echoed in the X-Request-ID response header, and logged as
// a structured JSON line with method, url, status, duration, user_id, and
// request_id. Downstream call sites should use `logger` instead of
// console.log so logs stay uniformly JSON.

const crypto = require('crypto');
const { pino } = require('pino');
const { performance } = require('perf_hooks');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'NomosAI-Backend' },
  timestamp: pino.stdTimeFunctions.isoTime
});

function requestLogger(req, res, next) {
  const requestId = req.header('X-Request-ID') || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  const start = performance.now();

  res.on('finish', () => {
    logger.info({
      requestId,
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      userId: req.user && req.user.id ? req.user.id : null
    });
  });

  next();
}

module.exports = { logger, requestLogger };
