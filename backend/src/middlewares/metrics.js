// Phase 29: Prometheus metrics.
//
// Exposes /metrics in Prometheus text format. Tracks HTTP request count,
// duration, error rate, AI query latency, DB query latency, and inference
// queue depth.

const client = require('prom-client');
const { performance } = require('perf_hooks');

// Reuse an already-registered metric when this module is evaluated twice
// (e.g. jest.isolateModules, a hot-reload harness, or a duplicate require in
// a future bundler). prom-client throws on duplicate registration, and a
// second registration would silently split observations across two metrics.
function getOrCreateMetric(name, factory) {
  return client.register.getSingleMetric(name) || factory();
}

// collectDefaultMetrics registers ~20 metrics in one call; only run it when
// the first one is absent so a reload cannot throw a duplicate-registration
// error halfway through boot.
if (!client.register.getSingleMetric('process_cpu_user_seconds_total')) {
  client.collectDefaultMetrics();
}

const httpRequestsTotal = getOrCreateMetric('nomos_http_requests_total', () =>
  new client.Counter({
    name: 'nomos_http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status']
  })
);

const httpRequestDuration = getOrCreateMetric('nomos_http_request_duration_seconds', () =>
  new client.Histogram({
    name: 'nomos_http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]
  })
);

const aiQueryDuration = getOrCreateMetric('nomos_ai_query_duration_seconds', () =>
  new client.Histogram({
    name: 'nomos_ai_query_duration_seconds',
    help: 'AI inference latency in seconds',
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
  })
);

// Low cardinality by design: SQL text/params must never become labels (they
// would explode the series count and leak query data). Only ok/error.
const dbQueryDuration = getOrCreateMetric('nomos_db_query_duration_seconds', () =>
  new client.Histogram({
    name: 'nomos_db_query_duration_seconds',
    help: 'Database query latency in seconds',
    labelNames: ['status'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
  })
);

// Current outstanding inference jobs (queued + running) for BOTH the Redis
// and inline execution paths. No labels: the queue is a single GPU-backed
// resource, so per-job labels would add cardinality without information.
const inferenceQueueDepth = getOrCreateMetric('inference_queue_depth', () =>
  new client.Gauge({
    name: 'inference_queue_depth',
    help: 'Outstanding inference jobs (queued or running)'
  })
);

// Resolve the low-cardinality route label for a finished request.
//
// Using `req.originalUrl` (the pre-Phase-31 behaviour for unmatched paths)
// labels every 404 with its raw URL, so scanners and probes create unbounded
// time series (and can leak IDs/query strings into Prometheus). Express
// exposes the matched route pattern on `req.route.path`; prepend the router
// mount (`req.baseUrl`) so `/api/documents/:id` stays a single series.
// Anything that did not match a route is deliberately collapsed to
// `unmatched`, and query strings are never part of either label.
function routeLabel(req) {
  if (!req.route || !req.route.path) return 'unmatched';

  // Express allows an array of paths for a single route; pick the first one
  // rather than joining (joining would multiply series for one handler).
  const path = Array.isArray(req.route.path) ? req.route.path[0] : req.route.path;
  if (typeof path !== 'string' || path.length === 0) return 'unmatched';

  const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const label = `${base}${path}`.replace(/\/{2,}/g, '/');
  if (!label) return 'unmatched';
  return label.startsWith('/') ? label : `/${label}`;
}

function metricsMiddleware(req, res, next) {
  const start = performance.now();
  res.on('finish', () => {
    const route = routeLabel(req);
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route }, (performance.now() - start) / 1000);
  });
  next();
}

function recordAiQueryDuration(ms) {
  aiQueryDuration.observe(ms / 1000);
}

function recordDbQueryDuration(ms, status = 'ok') {
  const label = status === 'error' ? 'error' : 'ok';
  dbQueryDuration.observe({ status: label }, ms / 1000);
}

async function metricsHandler(req, res) {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}

module.exports = {
  metricsMiddleware,
  metricsHandler,
  recordAiQueryDuration,
  recordDbQueryDuration,
  inferenceQueueDepth,
  routeLabel
};
