// 1-14 + 1-13: inference-queue hardening and DB timing metrics.
//
// Covers the inline (no-Redis) path — TTL pruning, serialized execution,
// gauge accounting, shutdown cleanup — plus the BullMQ option shape and
// retry/stall policy using mocked `bullmq` / `ioredis` (no real Redis).
// Also verifies config/db.js records ok/error query durations while keeping
// the promise + callback APIs intact.

const mockState = {
  queues: [],
  workers: [],
  queueEvents: [],
  connections: []
};
const mockPools = [];
const mockQueries = [];

jest.mock('../src/services/ollamaService', () => ({
  generateResponse: jest.fn()
}));

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => {
    const conn = {
      on: jest.fn(),
      ping: jest.fn().mockResolvedValue('PONG'),
      disconnect: jest.fn()
    };
    mockState.connections.push(conn);
    return conn;
  })
);

jest.mock('bullmq', () => {
  const { EventEmitter } = require('events');

  class MockWorker extends EventEmitter {
    constructor(name, processor, opts) {
      super();
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      this.close = jest.fn().mockResolvedValue(undefined);
      mockState.workers.push(this);
    }
  }

  class MockQueue {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.add = jest.fn().mockResolvedValue({ id: 'redis-job-1' });
      this.getJob = jest.fn().mockResolvedValue(null);
      this.getWaitingCount = jest.fn().mockResolvedValue(0);
      this.getActiveCount = jest.fn().mockResolvedValue(0);
      this.getCompletedCount = jest.fn().mockResolvedValue(0);
      this.getFailedCount = jest.fn().mockResolvedValue(0);
      this.getDelayedCount = jest.fn().mockResolvedValue(0);
      this.close = jest.fn().mockResolvedValue(undefined);
      mockState.queues.push(this);
    }
  }

  class MockQueueEvents {
    constructor(name, opts) {
      this.name = name;
      this.opts = opts;
      this.close = jest.fn().mockResolvedValue(undefined);
      mockState.queueEvents.push(this);
    }
  }

  return { Queue: MockQueue, Worker: MockWorker, QueueEvents: MockQueueEvents };
});

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => {
    const pool = {
      query: jest.fn(),
      connect: jest.fn(),
      end: jest.fn()
    };
    mockPools.push(pool);
    mockQueries.push(pool.query);
    return pool;
  })
}));

const MANAGED_ENV = [
  'NODE_ENV',
  'REDIS_URL',
  'INLINE_JOB_TTL_MS',
  'INLINE_JOB_PRUNE_INTERVAL_MS',
  'INLINE_QUEUE_CONCURRENCY',
  'INFERENCE_QUEUE_ATTEMPTS',
  'INFERENCE_QUEUE_BACKOFF_MS',
  'INFERENCE_QUEUE_ENQUEUE_TIMEOUT_MS',
  'INFERENCE_QUEUE_REMOVE_ON_COMPLETE',
  'INFERENCE_QUEUE_REMOVE_ON_FAIL',
  'INFERENCE_QUEUE_MAX_STALLED_COUNT',
  'INFERENCE_QUEUE_LOCK_DURATION_MS',
  'INFERENCE_QUEUE_STALLED_INTERVAL_MS'
];

let envBackup = {};

beforeEach(() => {
  envBackup = {};
  for (const key of MANAGED_ENV) envBackup[key] = process.env[key];
  mockState.queues.length = 0;
  mockState.workers.length = 0;
  mockState.queueEvents.length = 0;
  mockState.connections.length = 0;
  mockPools.length = 0;
  mockQueries.length = 0;
});

afterEach(() => {
  for (const key of MANAGED_ENV) {
    if (envBackup[key] === undefined) delete process.env[key];
    else process.env[key] = envBackup[key];
  }
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function loadModules(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  let modules;
  jest.isolateModules(() => {
    const metrics = require('../src/middlewares/metrics');
    const ollama = require('../src/services/ollamaService');
    const queue = require('../src/services/inferenceQueue');
    modules = { metrics, ollama, queue };
  });
  return modules;
}

function loadInline(env = {}) {
  return loadModules({ NODE_ENV: 'test', REDIS_URL: undefined, ...env });
}

function loadRedis(env = {}) {
  return loadModules({ NODE_ENV: 'development', REDIS_URL: 'redis://localhost:6379', ...env });
}

async function queueDepth(metrics) {
  const snapshot = await metrics.inferenceQueueDepth.get();
  return snapshot.values[0] ? snapshot.values[0].value : 0;
}

describe('inline queue hardening (1-14)', () => {
  it('serializes inline jobs when INLINE_QUEUE_CONCURRENCY=1 and resolves every result', async () => {
    const { queue, ollama, metrics } = loadInline({ INLINE_QUEUE_CONCURRENCY: '1' });
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];

    ollama.generateResponse.mockImplementation(async (prompt) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${prompt}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      order.push(`end:${prompt}`);
      return `answer:${prompt}`;
    });

    const pending = Promise.all([
      queue.addInferenceJob('one', 'ctx'),
      queue.addInferenceJob('two', 'ctx'),
      queue.addInferenceJob('three', 'ctx')
    ]);

    // All three are outstanding (one running + two waiting) before the first
    // generation finishes.
    expect(await queueDepth(metrics)).toBe(3);

    const jobs = await pending;
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([
      'start:one', 'end:one',
      'start:two', 'end:two',
      'start:three', 'end:three'
    ]);
    expect(jobs.map((job) => job.returnvalue)).toEqual([
      'answer:one', 'answer:two', 'answer:three'
    ]);
    expect(await queueDepth(metrics)).toBe(0);

    await queue.closeQueue();
  });

  it('releases the gate and decrements depth when an inline job fails', async () => {
    const { queue, ollama, metrics } = loadInline();
    ollama.generateResponse
      .mockRejectedValueOnce(new Error('gpu unavailable'))
      .mockResolvedValueOnce('recovered');

    await expect(queue.addInferenceJob('fail', 'ctx')).rejects.toThrow('gpu unavailable');
    expect(await queueDepth(metrics)).toBe(0);

    // A failure must not leak an inline concurrency slot.
    const job = await queue.addInferenceJob('next', 'ctx');
    expect(job.returnvalue).toBe('recovered');
    expect(await queueDepth(metrics)).toBe(0);

    await queue.closeQueue();
  });

  it('prunes expired inline results but keeps a job that is being polled', async () => {
    jest.useFakeTimers();
    const { queue, ollama, metrics } = loadInline({
      INLINE_JOB_TTL_MS: '30',
      INLINE_JOB_PRUNE_INTERVAL_MS: '10'
    });
    ollama.generateResponse.mockResolvedValue('ok');

    const job = await queue.addInferenceJob('ttl', 'ctx');
    expect(await queue.getJob(job.id)).toBe(job);

    // Poll just before expiry: the access must refresh the retention window.
    jest.advanceTimersByTime(10);
    expect(await queue.getJob(job.id)).toBe(job);

    jest.advanceTimersByTime(20); // t=30, 20 ms since the last poll
    expect(await queue.getJob(job.id)).toBe(job);

    jest.advanceTimersByTime(31); // t=61, 31 ms since the last poll > TTL
    expect(await queue.getJob(job.id)).toBeNull();
    expect(await queueDepth(metrics)).toBe(0);

    await queue.closeQueue();
  });

  it('clears retained inline jobs and the prune timer on shutdown', async () => {
    const { queue, ollama, metrics } = loadInline();
    ollama.generateResponse.mockResolvedValue('ok');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');

    const job = await queue.addInferenceJob('shutdown', 'ctx');
    expect(await queue.getJob(job.id)).toBe(job);

    await queue.closeQueue();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(await queue.getJob(job.id)).toBeNull();
    expect(await queueDepth(metrics)).toBe(0);
  });
});

describe('BullMQ queue hardening (1-14)', () => {
  it('configures retries/backoff/retention/stall policy and tracks depth', async () => {
    const { queue, metrics } = loadRedis({
      INFERENCE_QUEUE_ATTEMPTS: '4',
      INFERENCE_QUEUE_BACKOFF_MS: '250',
      INFERENCE_QUEUE_REMOVE_ON_COMPLETE: '50',
      INFERENCE_QUEUE_REMOVE_ON_FAIL: '25',
      INFERENCE_QUEUE_MAX_STALLED_COUNT: '2',
      INFERENCE_QUEUE_LOCK_DURATION_MS: '90000',
      INFERENCE_QUEUE_STALLED_INTERVAL_MS: '15000'
    });

    const job = await queue.addInferenceJob('prompt', 'ctx', { userId: 7 });
    const q = mockState.queues[0];

    expect(job).toEqual({ id: 'redis-job-1' });
    expect(q.add).toHaveBeenCalledWith(
      'generate',
      { prompt: 'prompt', contextStr: 'ctx', userId: 7 },
      {
        attempts: 4,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 25 }
      }
    );
    expect(await queueDepth(metrics)).toBe(1);

    await queue.startWorker();
    const worker = mockState.workers[0];
    expect(worker.opts).toMatchObject({
      concurrency: 1,
      maxStalledCount: 2,
      lockDuration: 90000,
      stalledInterval: 15000
    });

    worker.emit('active', job);
    expect(await queueDepth(metrics)).toBe(1);

    worker.emit('completed', job);
    expect(await queueDepth(metrics)).toBe(0);

    await queue.closeQueue();
    expect(worker.close).toHaveBeenCalled();
    expect(q.close).toHaveBeenCalled();
    expect(mockState.connections[0].disconnect).toHaveBeenCalled();
  });

  it('keeps retrying jobs in depth and drops the gauge only on final failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { queue, metrics } = loadRedis({ INFERENCE_QUEUE_ATTEMPTS: '3' });

    await queue.addInferenceJob('prompt', 'ctx');
    await queue.startWorker();
    const worker = mockState.workers[0];

    worker.emit('failed', { id: 'redis-job-1', attemptsMade: 1, opts: { attempts: 3 } }, new Error('transient'));
    expect(await queueDepth(metrics)).toBe(1);

    worker.emit('failed', { id: 'redis-job-1', attemptsMade: 3, opts: { attempts: 3 } }, new Error('final'));
    expect(await queueDepth(metrics)).toBe(0);

    errorSpy.mockRestore();
    await queue.closeQueue();
  });

  it('fails fast when enqueueing to Redis exceeds the enqueue timeout', async () => {
    const { queue } = loadRedis({ INFERENCE_QUEUE_ENQUEUE_TIMEOUT_MS: '30' });
    await queue.getQueueStatus(); // force lazy Queue creation
    mockState.queues[0].add.mockImplementationOnce(() => new Promise(() => {}));

    await expect(queue.addInferenceJob('prompt', 'ctx')).rejects.toThrow(
      /Inference queue enqueue timed out after 30 ms/
    );

    await queue.closeQueue();
  });
});

describe('config/db query timing (1-13)', () => {
  it('records ok/error durations and preserves promise + callback APIs', async () => {
    let modules;
    jest.isolateModules(() => {
      const promClient = require('prom-client');
      const metrics = require('../src/middlewares/metrics');
      const db = require('../src/config/db');
      modules = { promClient, metrics, db };
    });

    const { db, promClient } = modules;
    const pool = mockPools[0];
    const queryMock = mockQueries[0];
    expect(db).toBe(pool);
    expect(db.pool).toBe(pool);
    expect(db.query).not.toBe(queryMock); // instrumented wrapper, not the raw mock

    queryMock.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    await expect(db.query('SELECT 1', [])).resolves.toEqual({ rows: [{ ok: 1 }] });

    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(db.query('SELECT 2')).rejects.toThrow('db down');

    queryMock.mockImplementationOnce((_sql, callback) => callback(null, { rows: [] }));
    await new Promise((resolve, reject) => {
      db.query('SELECT 3', (err, result) => {
        try {
          expect(err).toBeNull();
          expect(result).toEqual({ rows: [] });
          resolve();
        } catch (assertionErr) {
          reject(assertionErr);
        }
      });
    });

    const histogram = promClient.register.getSingleMetric('nomos_db_query_duration_seconds');
    const snapshot = await histogram.get();
    const countFor = (status) => {
      const sample = snapshot.values.find(
        (value) =>
          value.metricName === 'nomos_db_query_duration_seconds_count' &&
          value.labels.status === status
      );
      return sample ? sample.value : 0;
    };
    expect(countFor('ok')).toBe(2);
    expect(countFor('error')).toBe(1);
  });

  it('reuses metrics instead of throwing on duplicate registration', () => {
    const first = require('../src/middlewares/metrics');
    const modulePath = require.resolve('../src/middlewares/metrics');
    delete require.cache[modulePath];
    const second = require('../src/middlewares/metrics');

    expect(second.inferenceQueueDepth).toBe(first.inferenceQueueDepth);
    expect(second.recordDbQueryDuration).toEqual(expect.any(Function));
  });
});
