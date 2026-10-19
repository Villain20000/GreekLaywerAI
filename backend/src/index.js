const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const aiRoutes = require('./routes/ai');
const billingRoutes = require('./routes/billing');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const conversationsRoutes = require('./routes/conversations');
const documentsRoutes = require('./routes/documents');
const subscriptionsRoutes = require('./routes/subscriptions');
const gdprRoutes = require('./routes/gdpr');
const webhookRoutes = require('./routes/webhook');
const privacyShield = require('./middlewares/privacyShield');
const { securityHeaders } = require('./middlewares/security');
const { requestLogger } = require('./middlewares/requestLogger');
const { metricsMiddleware, metricsHandler } = require('./middlewares/metrics');
const { authMiddleware } = require('./middlewares/authMiddleware');
const ollamaService = require('./services/ollamaService');
const inferenceQueue = require('./services/inferenceQueue');
const stripeService = require('./services/stripeService');
const db = require('./config/db');

const app = express();
const port = process.env.PORT || 3000;

// `trust proxy` controls what `req.ip` resolves to under a reverse proxy
// (nginx, Cloudflare, a docker-network gateway). The default of
// 'uniquelocal,loopback' trusts private-network hops so a deployed NomosAI
// instance behind one reverse proxy uses the real client IP. Operators
// behind a multi-hop chain should set TRUST_PROXY to an explicit count
// (e.g. '2') or to a CIDR list. Leaving it at the default while pretending
// the X-Forwarded-For header is the source-of-truth IP is the easiest way
// to rate-limit the wrong value and DoS the whole site.
app.set('trust proxy', process.env.TRUST_PROXY || 'uniquelocal,loopback');

// ===========================================================================
// Phase 29: Security hardening.
// ===========================================================================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false // keep blob: media streaming working
  })
);

// CORS origin whitelist from env (comma-separated). No origins configured
// → mirror the old permissive dev behavior; production MUST set it.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
          return cb(new Error('Not allowed by CORS'));
        }
      : true,
    credentials: false
  })
);

// Stripe webhook needs the RAW body for signature verification, so it is
// mounted BEFORE the JSON parsers (body-parser skips already-parsed paths).
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(requestLogger);
app.use(metricsMiddleware);
app.use(securityHeaders);
// 1-12: CSRF middleware removed — auth is Bearer-token only (no cookies), so
// there is no CSRF surface to protect. See middlewares/security.js.
app.use(privacyShield); // Apply globally for NomosAI

// Phase 28 (pre-warm): anonymous health endpoints. Registered BEFORE the
// protected `/api/ai` mount so they short-circuit before authMiddleware
// and never require a Bearer token. Useful for orchestrator liveness
// probes and operator post-deploy verification.
//
// Phase 29: enhanced health check — DB, Redis, Ollama warmup, Stripe
// config, and inference-queue status. 200 when everything is up,
// 503 when any critical check is down.
async function dbHealth() {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    return { status: 'up', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'down', latency_ms: Date.now() - start, error: err.message };
  }
}

app.get('/health', async (req, res) => {
  const [database, redis, queue, ollama] = await Promise.all([
    dbHealth(),
    inferenceQueue.pingRedis().then((latency) => ({
      status: latency !== null ? 'up' : 'down',
      latency_ms: latency
    })),
    inferenceQueue.getQueueStatus(),
    Promise.resolve(ollamaService.getWarmupStatus())
  ]);

  const checks = {
    database,
    redis,
    queue,
    ollama: {
      status: ollama.status,
      embedModel: ollama.embedModel,
      chatModel: ollama.chatModel,
      embedDim: ollama.embedDim,
      embedWarmed: ollama.embedWarmed,
      chatWarmed: ollama.chatWarmed
    },
    stripe: {
      status: stripeService.isConfigured() ? 'configured' : 'missing'
    }
  };

  const anyDown = database.status === 'down' || redis.status === 'down';
  const status = anyDown ? 'unhealthy' : 'ok';

  res.status(anyDown ? 503 : 200).json({
    status,
    service: 'NomosAI Backend',
    timestamp: new Date().toISOString(),
    localPrivacyEnabled: req.isLocallyProcessed,
    checks
  });
});

app.get('/api/ai/health', (req, res) => {
  // Reuses ollamaService.getWarmupStatus() so the per-model state is
  // consistent across both endpoints. The /api/ai/health path is the
  // canonical "is my AI subsystem ready?" check for K8s readinessProbes
  // and docker-compose healthchecks.
  res.json({
    service: 'NomosAI',
    ...ollamaService.getWarmupStatus()
  });
});

app.use('/api/auth', authRoutes); // buildAuthRouter(factory) already wired in require
app.use('/api/ai', authMiddleware, aiRoutes); // Per-route RBAC inside ai.js

// Stripe webhook MUST be mounted BEFORE the authMiddleware-guarded
// `/api/billing` mount below: `app.use('/api/billing', authMiddleware, ...)`
// matches every `/api/billing/*` path, so a later-registered webhook route
// would be shadowed by the 401 from authMiddleware (Stripe never sends a
// Bearer token). Body arrives raw — see the express.raw() parser above.
app.use('/api/billing/webhook', webhookRoutes); // raw-body, signature-verified

app.use('/api/billing', authMiddleware, billingRoutes); // Per-route RBAC inside billing.js
app.use('/api/conversations', authMiddleware, conversationsRoutes);
app.use('/api/documents', authMiddleware, documentsRoutes);
app.use('/api/subscriptions', authMiddleware, subscriptionsRoutes);
app.use('/api/gdpr', authMiddleware, gdprRoutes);
app.use('/api/admin', adminRoutes); // admin-only (gated inside admin.js)

// Phase 29: Prometheus metrics endpoint (no auth — scraped by Prometheus).
app.get('/metrics', metricsHandler);

// ===========================================================================
// Phase 1-2: global error handler. Registered LAST so every error raised by
// an earlier middleware/route (multer upload caps, body-parser, an unexpected
// throw) is serialized as a JSON envelope instead of Express' default HTML
// error page. Stack traces are logged server-side but never returned.
// ===========================================================================
function globalErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Multer aborts oversized uploads with a MulterError raised from inside the
  // upload middleware, so route-level try/catch blocks never see it.
  if (err && err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large' });
  }

  // body-parser JSON syntax errors (`entity.parse.failed` is a SyntaxError
  // carrying status 400 under the hood).
  if (
    err &&
    (err.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400)))
  ) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // Body larger than the express.json()/urlencoded limit: a client error, so
  // keep the 413 the default handler would have used — but as JSON.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }

  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  return res.status(500).json({ error: 'Internal server error' });
}

app.use(globalErrorHandler);

// Phase 29: graceful shutdown — stop accepting connections, drain, exit.
// `server` stays null when this module is imported (tests) instead of being
// executed directly (`node src/index.js` / `npm start`).
let server = null;

if (require.main === module) {
  server = app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
    // Phase 28: pre-warm gemma:2b (chat) and bge-m3 (embed) so the first
    // /api/ai/query doesn't pay the ~180 s cold-load penalty. Fire-and-forget.
    ollamaService.warmup().catch((err) => {
      console.error(`[warmup] unhandled error: ${err && err.message}`);
    });
    // Phase 29: start the inference queue worker (idempotent; no-op when
    // Redis is not configured).
    inferenceQueue.startWorker();
  });
}

async function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — draining connections`);
  const forceExit = setTimeout(() => {
    console.error('[SHUTDOWN] Timed out after 30s — forcing exit');
    process.exit(1);
  }, 30000);
  forceExit.unref();

  try {
    if (server && typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    console.log('[SHUTDOWN] HTTP server closed');
  } catch (err) {
    console.error('[SHUTDOWN] Error closing server:', err.message);
  }

  try { await db.end(); console.log('[SHUTDOWN] DB pool closed'); } catch (err) { console.error('[SHUTDOWN] DB close error:', err.message); }
  try { await inferenceQueue.closeQueue(); console.log('[SHUTDOWN] Queue closed'); } catch (err) { console.error('[SHUTDOWN] Queue close error:', err.message); }

  clearTimeout(forceExit);
  console.log('[SHUTDOWN] Clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Exported for tests: suites mount the REAL error handler on the mocked app
// from tests/app.js (which intentionally only mounts routers), so the 413/400/
// 500 mapping is verified against production code instead of a copy.
module.exports = { app, globalErrorHandler };
