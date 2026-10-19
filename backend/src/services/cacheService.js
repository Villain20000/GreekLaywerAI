// Redis-backed response cache. Lazy, namespaced and strictly fail-open:
// no REDIS_URL or an unreachable Redis degrades every call to a cache miss,
// never to an application error.

const crypto = require('crypto');

const PREFIX = process.env.CACHE_PREFIX || 'nomos:cache';
const DEFAULT_TTL_SECONDS = 300;

let client = null;
let clientFailed = false;
const loggedErrors = new Set();

function warnOnce(scope, err) {
  const code = (err && (err.code || err.name)) || 'Error';
  if (loggedErrors.has(code)) return;
  loggedErrors.add(code);
  console.warn(`[cache] ${scope} error (${code}): ${err && err.message ? err.message : err}`);
}

function getClient() {
  if (client) return client;
  if (clientFailed || !process.env.REDIS_URL) return null;

  try {
    // Required lazily so tests/dev without Redis never open a socket at load.
    const IORedis = require('ioredis');
    client = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
      retryStrategy: (times) => Math.min(times * 500, 5000)
    });
    client.on('error', (err) => warnOnce('connection', err));
    return client;
  } catch (err) {
    clientFailed = true;
    warnOnce('init', err);
    return null;
  }
}

function buildKey(key) {
  return `${PREFIX}:${key}`;
}

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizedTtl(ttlSeconds) {
  const parsed = Number(ttlSeconds);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.max(1, Math.floor(parsed));
}

async function getJson(key) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(buildKey(key));
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  } catch (err) {
    warnOnce('get', err);
    return null;
  }
}

async function setJson(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const redis = getClient();
  if (!redis) return false;
  try {
    await redis.set(buildKey(key), JSON.stringify(value), 'EX', normalizedTtl(ttlSeconds));
    return true;
  } catch (err) {
    warnOnce('set', err);
    return false;
  }
}

async function del(key) {
  const redis = getClient();
  if (!redis) return false;
  try {
    await redis.del(buildKey(key));
    return true;
  } catch (err) {
    warnOnce('del', err);
    return false;
  }
}

// Test-only reset: drops the singleton client and the once-per-error-class
// log bookkeeping so suites can exercise connected/unreachable states.
function __resetForTests() {
  client = null;
  clientFailed = false;
  loggedErrors.clear();
}

module.exports = {
  getJson,
  setJson,
  del,
  buildKey,
  hashKey,
  __resetForTests
};
