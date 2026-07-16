const express = require('express');
const cors = require('cors');
const aiRoutes = require('./routes/ai');
const billingRoutes = require('./routes/billing');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const privacyShield = require('./middlewares/privacyShield');
const { authMiddleware } = require('./middlewares/authMiddleware');
const ollamaService = require('./services/ollamaService');

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

app.use(cors());
app.use(express.json());
app.use(privacyShield); // Apply globally for NomosAI

// Phase 28 (pre-warm): anonymous health endpoints. Registered BEFORE the
// protected `/api/ai` mount so they short-circuit before authMiddleware
// and never require a Bearer token. Useful for orchestrator liveness
// probes and operator post-deploy verification.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NomosAI Backend',
    localPrivacyEnabled: req.isLocallyProcessed,
    ollama: ollamaService.getWarmupStatus()
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
app.use('/api/billing', authMiddleware, billingRoutes); // Per-route RBAC inside billing.js
app.use('/api/admin', adminRoutes); // admin-only (gated inside admin.js)

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
  // Phase 28: pre-warm gemma:2b (chat) and nomic-embed-text (embed) so
  // the first /api/ai/query doesn't pay the ~180 s cold-load penalty.
  // Fire-and-forget: app.listen has already returned, so requests are
  // accepted immediately; /api/ai/health surfaces the warming state so
  // callers (or K8s readinessProbe) can defer real traffic until ready.
  ollamaService.warmup().catch((err) => {
    // warmup() is internally try/caught per leg, so an error reaching
    // this catch is unexpected (e.g. warmupPromise rejection somehow
    // escaped). Log loudly but never crash the boot path.
    console.error(`[warmup] unhandled error: ${err && err.message}`);
  });
});
