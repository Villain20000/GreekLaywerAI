// Phase 29: Prometheus metrics.
//
// Exposes /metrics in Prometheus text format. Tracks HTTP request count,
// duration, error rate, AI query latency, and DB query latency.

const client = require('prom-client');
const { performance } = require('perf_hooks');

client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'nomos_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status']
});

const httpRequestDuration = new client.Histogram({
  name: 'nomos_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120]
});

const aiQueryDuration = new client.Histogram({
  name: 'nomos_ai_query_duration_seconds',
  help: 'AI inference latency in seconds',
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]
});

const dbQueryDuration = new client.Histogram({
  name: 'nomos_db_query_duration_seconds',
  help: 'Database query latency in seconds',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
});

function metricsMiddleware(req, res, next) {
  const start = performance.now();
  res.on('finish', () => {
    const route = req.route ? req.route.path : (req.baseUrl + (req.path || req.originalUrl || ''));
    httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, route }, (performance.now() - start) / 1000);
  });
  next();
}

function recordAiQueryDuration(ms) {
  aiQueryDuration.observe(ms / 1000);
}

function recordDbQueryDuration(ms) {
  dbQueryDuration.observe(ms / 1000);
}

async function metricsHandler(req, res) {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}

module.exports = {
  metricsMiddleware,
  metricsHandler,
  recordAiQueryDuration,
  recordDbQueryDuration
};
