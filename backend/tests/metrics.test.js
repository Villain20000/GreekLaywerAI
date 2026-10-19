// 3-1: HTTP metric route-label cardinality.
//
// The middleware used to fall back to req.originalUrl/baseUrl+path for
// unmatched requests, so every distinct 404 (including query strings and raw
// document IDs) created a new Prometheus series. These tests pin the label to
// the matched Express route pattern and collapse everything else to
// `unmatched`.

const express = require('express');
const request = require('supertest');
const client = require('prom-client');

const { metricsMiddleware, routeLabel } = require('../src/middlewares/metrics');

function buildApp() {
  const app = express();
  app.use(metricsMiddleware);

  const documents = express.Router();
  documents.get('/:id', (req, res) => res.json({ id: req.params.id }));
  app.use('/api/documents', documents);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  return app;
}

async function metricValues(name) {
  const metric = client.register.getSingleMetric(name);
  return (await metric.get()).values;
}

function flushFinishHandlers() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('metrics middleware route labels', () => {
  beforeEach(() => {
    client.register.resetMetrics();
  });

  it('keeps the existing metric names stable', () => {
    for (const name of [
      'nomos_http_requests_total',
      'nomos_http_request_duration_seconds',
      'nomos_ai_query_duration_seconds',
      'nomos_db_query_duration_seconds',
      'inference_queue_depth'
    ]) {
      expect(client.register.getSingleMetric(name)).toBeDefined();
    }
  });

  it('labels a parameterized route with one pattern, not raw IDs/query strings', async () => {
    const app = buildApp();
    await request(app).get('/api/documents/doc-123?access_token=top-secret').expect(200);
    await request(app).get('/api/documents/doc-456').expect(200);
    await flushFinishHandlers();

    const values = await metricValues('nomos_http_requests_total');
    const routeSeries = values.filter((entry) => entry.labels.route === '/api/documents/:id');

    expect(routeSeries).toHaveLength(1);
    expect(routeSeries[0].labels).toEqual({
      method: 'GET',
      route: '/api/documents/:id',
      status: 200
    });
    expect(routeSeries[0].value).toBe(2);

    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('doc-123');
    expect(serialized).not.toContain('doc-456');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('top-secret');
  });

  it('collapses distinct unmatched URLs to a single `unmatched` label', async () => {
    const app = buildApp();
    await request(app).get('/does-not-exist/one').expect(404);
    await request(app).get('/totally/different/two?probe=scanner').expect(404);
    await flushFinishHandlers();

    const values = await metricValues('nomos_http_requests_total');
    const unmatched = values.filter(
      (entry) => entry.labels.route === 'unmatched' && Number(entry.labels.status) === 404
    );

    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].value).toBe(2);

    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('does-not-exist');
    expect(serialized).not.toContain('totally/different');
    expect(serialized).not.toContain('scanner');
  });

  it('matches the duration histogram label to the same route pattern', async () => {
    const app = buildApp();
    await request(app).get('/api/documents/abc').expect(200);
    await flushFinishHandlers();

    const values = await metricValues('nomos_http_request_duration_seconds');
    const series = values.filter((entry) => entry.metricName.endsWith('_count'));
    const labelSets = series.map((entry) => entry.labels);

    expect(labelSets).toContainEqual({ method: 'GET', route: '/api/documents/:id' });
    expect(JSON.stringify(labelSets)).not.toContain('abc');
  });

  it('routeLabel falls back to `unmatched` for missing/non-string route paths', () => {
    expect(routeLabel({ route: null })).toBe('unmatched');
    expect(routeLabel({ route: { path: /^\/regex$/ } })).toBe('unmatched');
    expect(routeLabel({ route: { path: '/health' }, baseUrl: '' })).toBe('/health');
    expect(routeLabel({ route: { path: ['/one', '/two'] }, baseUrl: '/api' })).toBe('/api/one');
  });
});
