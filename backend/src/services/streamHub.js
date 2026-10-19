// Per-job token stream fan-out for the live chat endpoint.
//
// Production uses Redis pub/sub so the worker process that owns the GPU and
// the HTTP process that holds the SSE connection can live in different
// containers. Development and tests use an in-process fallback with the same
// delivery semantics (history replay + live fan-out), so no Redis is needed.
//
// Events are assigned a monotonically increasing `seq` per job. A subscriber
// first replays the buffered history and then consumes live messages,
// dropping already-seen sequence numbers. This closes the race where the
// worker starts streaming while the browser is still opening the SSE
// connection, without ever replaying one job's tokens into another job's
// stream: channels and keys are namespaced by the job id, and the SSE route
// verifies job ownership before subscribing.

const IORedis = require('ioredis');

const NODE_ENV = process.env.NODE_ENV || 'development';
const KEY_PREFIX = 'nomos:ai:stream';
const CHANNEL_PREFIX = `${KEY_PREFIX}:events:`;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

// Terminal events (and the buffered chunks before them) are kept only long
// enough for a reconnecting or late subscriber to catch up.
const STREAM_TTL_MS = positiveInt(process.env.AI_STREAM_TTL_MS, 10 * 60 * 1000);
const MAX_LOG_EVENTS = positiveInt(process.env.AI_STREAM_MAX_LOG_EVENTS, 5000);
// Redis is a transport, never a reason to stall the GPU loop. A dead/offline
// Redis queues commands indefinitely by default, so both publishing and
// subscribing are bounded.
const PUBLISH_TIMEOUT_MS = positiveInt(process.env.AI_STREAM_PUBLISH_TIMEOUT_MS, 2000);
const SUBSCRIBE_TIMEOUT_MS = positiveInt(process.env.AI_STREAM_SUBSCRIBE_TIMEOUT_MS, 5000);
const REDIS_FAILURE_COOLDOWN_MS = positiveInt(process.env.AI_STREAM_REDIS_COOLDOWN_MS, 30000);

let pubClient = null;
let subClient = null;
// After a timeout, stop attempting Redis for a short cooldown so every token
// does not pay the timeout while Redis is down. Polling still delivers the
// finished answer.
let redisFailureUntil = 0;

// jobId -> { seq, history, subscribers, terminalTimer }
const localStreams = new Map();
// channel -> Set<{ handler, replaying, lastSeq, terminalSent, buffer }>
const redisListeners = new Map();

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeJobId(jobId) {
  if (jobId === undefined || jobId === null) return null;
  const id = String(jobId);
  if (!id || id.length > 128) return null;
  return id;
}

function channelFor(jobId) {
  return `${CHANNEL_PREFIX}${jobId}`;
}

function seqKeyFor(jobId) {
  return `${KEY_PREFIX}:seq:${jobId}`;
}

function logKeyFor(jobId) {
  return `${KEY_PREFIX}:log:${jobId}`;
}

function terminalKeyFor(jobId) {
  return `${KEY_PREFIX}:terminal:${jobId}`;
}

function canUseRedis() {
  return NODE_ENV !== 'test' && Boolean(process.env.REDIS_URL);
}

function getPubClient() {
  if (!canUseRedis()) return null;
  if (pubClient) return pubClient;
  pubClient = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  pubClient.on('error', (err) => {
    console.error(`[STREAM] Redis publish client error: ${err.message}`);
  });
  return pubClient;
}

function getSubClient() {
  if (!canUseRedis()) return null;
  if (subClient) return subClient;
  subClient = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  subClient.on('error', (err) => {
    console.error(`[STREAM] Redis subscribe client error: ${err.message}`);
  });
  subClient.on('message', (channel, raw) => {
    const listeners = redisListeners.get(channel);
    if (!listeners) return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch (_err) {
      return;
    }
    for (const state of listeners) {
      if (state.replaying) {
        state.buffer.push(event);
      } else {
        deliver(state, event);
      }
    }
  });
  return subClient;
}

function getOrCreateLocalStream(jobId) {
  let stream = localStreams.get(jobId);
  if (!stream) {
    stream = { seq: 0, history: [], subscribers: new Set(), terminalTimer: null };
    localStreams.set(jobId, stream);
  }
  return stream;
}

function scheduleLocalCleanup(jobId, stream) {
  if (stream.terminalTimer) clearTimeout(stream.terminalTimer);
  stream.terminalTimer = setTimeout(() => {
    if (localStreams.get(jobId) === stream) localStreams.delete(jobId);
  }, STREAM_TTL_MS);
  if (typeof stream.terminalTimer.unref === 'function') stream.terminalTimer.unref();
}

function deliver(state, event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'chunk') {
    if (state.terminalSent) return;
    if (typeof event.content !== 'string' || event.content.length === 0) return;
    const seq = Number(event.seq);
    if (Number.isFinite(seq) && seq > 0) {
      if (seq <= state.lastSeq) return;
      state.lastSeq = seq;
    }
    try {
      const result = state.handler(event);
      if (result && typeof result.catch === 'function') result.catch(() => undefined);
    } catch (err) {
      console.error(`[STREAM] subscriber handler failed: ${err.message}`);
    }
    return;
  }
  if (event.type === 'done' || event.type === 'error') {
    if (state.terminalSent) return;
    state.terminalSent = true;
    try {
      const result = state.handler(event);
      if (result && typeof result.catch === 'function') result.catch(() => undefined);
    } catch (err) {
      console.error(`[STREAM] subscriber handler failed: ${err.message}`);
    }
  }
}

function publishLocal(jobId, event) {
  const stream = getOrCreateLocalStream(jobId);
  stream.seq += 1;
  const payload = { ...event, seq: stream.seq };
  stream.history.push(payload);
  if (stream.history.length > MAX_LOG_EVENTS) {
    stream.history.splice(0, stream.history.length - MAX_LOG_EVENTS);
  }
  if (payload.type === 'done' || payload.type === 'error') {
    scheduleLocalCleanup(jobId, stream);
  }
  for (const listener of Array.from(stream.subscribers)) {
    deliver(listener, payload);
  }
  return payload;
}

async function publishRedis(client, jobId, event) {
  const seq = await client.incr(seqKeyFor(jobId));
  const payload = { ...event, seq };
  const serialized = JSON.stringify(payload);
  const multi = client.multi();
  multi.rpush(logKeyFor(jobId), serialized);
  multi.ltrim(logKeyFor(jobId), -MAX_LOG_EVENTS, -1);
  multi.pexpire(logKeyFor(jobId), STREAM_TTL_MS);
  multi.pexpire(seqKeyFor(jobId), STREAM_TTL_MS);
  if (payload.type === 'done' || payload.type === 'error') {
    multi.set(terminalKeyFor(jobId), serialized, 'PX', STREAM_TTL_MS);
  }
  await multi.exec();
  await client.publish(channelFor(jobId), serialized);
  return payload;
}

async function publish(jobId, event) {
  const id = normalizeJobId(jobId);
  if (!id) return null;
  const client = getPubClient();
  if (!client) return publishLocal(id, event);
  if (Date.now() < redisFailureUntil) return null;
  try {
    const result = await withTimeout(publishRedis(client, id, event), PUBLISH_TIMEOUT_MS, 'stream publish');
    redisFailureUntil = 0;
    return result;
  } catch (err) {
    // Publishing must never abort the model run: the polling fallback can
    // still deliver the finished answer/persistence path.
    redisFailureUntil = Date.now() + REDIS_FAILURE_COOLDOWN_MS;
    console.error(`[STREAM] publish failed for job ${id}: ${err.message}`);
    return null;
  }
}

function publishChunk(jobId, content) {
  if (typeof content !== 'string' || content.length === 0) return Promise.resolve(null);
  return publish(jobId, { type: 'chunk', content });
}

function publishDone(jobId, payload = {}) {
  return publish(jobId, {
    type: 'done',
    result: typeof payload.result === 'string' ? payload.result : '',
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    confidence: Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : 0
  });
}

function publishError(jobId, message) {
  return publish(jobId, {
    type: 'error',
    error: typeof message === 'string' && message ? message : 'Inference stream failed'
  });
}

function subscribeLocal(jobId, handler) {
  const stream = getOrCreateLocalStream(jobId);
  const state = { handler, replaying: false, lastSeq: 0, terminalSent: false, buffer: [] };
  // JS is single-threaded here: replay the snapshot, then register for live
  // events, so no chunk can fall between the two steps.
  for (const event of stream.history.slice()) deliver(state, event);
  stream.subscribers.add(state);
  return () => {
    stream.subscribers.delete(state);
  };
}

async function subscribeRedis(jobId, handler) {
  const client = getSubClient();
  if (!client) return subscribeLocal(jobId, handler);

  const channel = channelFor(jobId);
  const state = { handler, replaying: true, lastSeq: 0, terminalSent: false, buffer: [] };
  let listeners = redisListeners.get(channel);
  if (!listeners) {
    listeners = new Set();
    redisListeners.set(channel, listeners);
  }
  listeners.add(state);

  try {
    if (listeners.size === 1) await client.subscribe(channel);
  } catch (err) {
    listeners.delete(state);
    if (listeners.size === 0) redisListeners.delete(channel);
    throw err;
  }

  try {
    const history = await client.lrange(logKeyFor(jobId), 0, -1);
    for (const raw of history) {
      try {
        deliver(state, JSON.parse(raw));
      } catch (_err) {
        // Skip a malformed buffered event.
      }
    }
    // The log is trimmed eventually; the terminal key outlives it for late
    // subscribers unless the whole TTL has elapsed.
    if (!state.terminalSent) {
      const terminalRaw = await client.get(terminalKeyFor(jobId));
      if (terminalRaw) deliver(state, JSON.parse(terminalRaw));
    }
  } catch (err) {
    console.error(`[STREAM] replay failed for job ${jobId}: ${err.message}`);
  }

  state.replaying = false;
  const buffered = state.buffer.splice(0).sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  for (const event of buffered) deliver(state, event);

  return () => {
    listeners.delete(state);
    if (listeners.size === 0) {
      redisListeners.delete(channel);
      try {
        const result = client.unsubscribe(channel);
        if (result && typeof result.catch === 'function') result.catch(() => undefined);
      } catch (_err) {
        // Connection already gone.
      }
    }
  };
}

/**
 * Subscribe to one job's events. Replays buffered chunks/terminal first, then
 * live events. Returns an unsubscribe function (safe to call more than once).
 */
async function subscribe(jobId, handler) {
  const id = normalizeJobId(jobId);
  if (!id || typeof handler !== 'function') return () => {};
  if (!getSubClient()) return subscribeLocal(id, handler);
  if (Date.now() < redisFailureUntil) {
    throw new Error('Stream transport unavailable');
  }
  try {
    const unsubscribe = await withTimeout(
      subscribeRedis(id, handler),
      SUBSCRIBE_TIMEOUT_MS,
      'stream subscribe'
    );
    redisFailureUntil = 0;
    return unsubscribe;
  } catch (err) {
    redisFailureUntil = Date.now() + REDIS_FAILURE_COOLDOWN_MS;
    throw err;
  }
}

async function close() {
  for (const stream of localStreams.values()) {
    if (stream.terminalTimer) clearTimeout(stream.terminalTimer);
  }
  localStreams.clear();
  redisListeners.clear();
  redisFailureUntil = 0;
  if (subClient) {
    try { subClient.disconnect(); } catch (_err) { /* ignore */ }
    subClient = null;
  }
  if (pubClient) {
    try { pubClient.disconnect(); } catch (_err) { /* ignore */ }
    pubClient = null;
  }
}

module.exports = {
  publishChunk,
  publishDone,
  publishError,
  subscribe,
  close
};
