const { Pool } = require('pg');
const { recordDbQueryDuration } = require('../middlewares/metrics');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'nomos_admin',
  password: process.env.DB_PASSWORD || 'nomos_password',
  database: process.env.DB_NAME || 'nomos_db'
});

// 1-13: record every query's latency (success AND failure) in the
// low-cardinality `status="ok|error"` histogram. Instrumenting the shared
// pool here covers routes, services, and scripts without touching call sites.
// The wrapper is transparent: promise and callback forms keep their exact
// signatures/return values, and metric failures can never break a query.
const originalQuery = pool.query.bind(pool);

pool.query = function timedQuery(...args) {
  const startedAt = process.hrtime.bigint();
  const callbackIndex = typeof args[args.length - 1] === 'function' ? args.length - 1 : -1;
  let recorded = false;

  const record = (status) => {
    if (recorded) return;
    recorded = true;
    try {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      recordDbQueryDuration(elapsedMs, status);
    } catch (_err) {
      // Observability must never fail the query path.
    }
  };

  if (callbackIndex !== -1) {
    const callback = args[callbackIndex];
    args[callbackIndex] = (err, result) => {
      record(err ? 'error' : 'ok');
      callback(err, result);
    };
  }

  try {
    const result = originalQuery(...args);
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          record('ok');
          return value;
        },
        (err) => {
          record('error');
          throw err;
        }
      );
    }
    // Callback form returns undefined; the wrapped callback records the
    // outcome. A no-callback, non-promise return (custom/edge client) is
    // treated as success.
    if (callbackIndex === -1) record('ok');
    return result;
  } catch (err) {
    record('error');
    throw err;
  }
};

// Keep the historical default export (the pool itself, so pool.query /
// pool.connect / pool.end / pool.on all still work) and expose the
// conventional `db.pool` alias for callers that prefer it.
pool.pool = pool;

module.exports = pool;
