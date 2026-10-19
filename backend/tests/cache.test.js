// Redis response-cache behavior: hit/miss, TTL forwarding, fail-open, and
// the RAG integration (global legislation rows only, normalized-query key).

process.env.NODE_ENV = 'test';
process.env.REDIS_URL = 'redis://cache.test:6379';

const mockGet = jest.fn();
const mockSet = jest.fn();
const mockDel = jest.fn();
const mockOn = jest.fn();
const mockRedis = { get: mockGet, set: mockSet, del: mockDel, on: mockOn };

jest.mock('ioredis', () => jest.fn(() => mockRedis));
jest.mock('../src/config/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/ollamaService', () => ({ generateEmbedding: jest.fn() }));

const IORedis = require('ioredis');
const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const cacheService = require('../src/services/cacheService');
const ragService = require('../src/services/ragService');

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

function errorWithCode(message, code) {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  jest.clearAllMocks();
  cacheService.__resetForTests();
  mockGet.mockReset().mockResolvedValue(null);
  mockSet.mockReset().mockResolvedValue('OK');
  mockDel.mockReset().mockResolvedValue(1);
  db.query.mockReset();
  ollamaService.generateEmbedding.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

describe('cacheService', () => {
  it('returns a parsed value on a cache hit using the namespace prefix', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ plans: ['pro'] }));

    const value = await cacheService.getJson('billing:plans');

    expect(value).toEqual({ plans: ['pro'] });
    expect(mockGet).toHaveBeenCalledWith('nomos:cache:billing:plans');
  });

  it('returns null on a cache miss', async () => {
    await expect(cacheService.getJson('missing')).resolves.toBeNull();
  });

  it('stores JSON with an explicit expiry', async () => {
    const ok = await cacheService.setJson('billing:plans', { plans: [] }, 120);

    expect(ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      'nomos:cache:billing:plans',
      JSON.stringify({ plans: [] }),
      'EX',
      120
    );
  });

  it('deletes namespaced keys', async () => {
    await expect(cacheService.del('billing:plans')).resolves.toBe(true);
    expect(mockDel).toHaveBeenCalledWith('nomos:cache:billing:plans');
  });

  it('fails open and logs an error class only once when Redis rejects', async () => {
    const refused = errorWithCode('connect ECONNREFUSED', 'ECONNREFUSED');
    mockGet.mockRejectedValue(refused);

    await expect(cacheService.getJson('a')).resolves.toBeNull();
    await expect(cacheService.getJson('b')).resolves.toBeNull();

    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toContain('ECONNREFUSED');
  });

  it('returns false instead of throwing when a write fails', async () => {
    mockSet.mockRejectedValue(errorWithCode('write failed', 'ETIMEDOUT'));

    await expect(cacheService.setJson('a', { x: 1 }, 60)).resolves.toBe(false);
  });

  it('is a no-op when REDIS_URL is not configured', async () => {
    delete process.env.REDIS_URL;
    cacheService.__resetForTests();
    jest.clearAllMocks();

    await expect(cacheService.getJson('a')).resolves.toBeNull();
    await expect(cacheService.setJson('a', { x: 1 }, 60)).resolves.toBe(false);
    expect(IORedis).not.toHaveBeenCalled();
  });

  it('hashes normalized input deterministically', () => {
    expect(cacheService.hashKey('abc')).toBe(cacheService.hashKey('abc'));
    expect(cacheService.hashKey('abc')).not.toBe(cacheService.hashKey('abd'));
    expect(cacheService.hashKey('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('ragService cache integration', () => {
  const rows = [{ id: 1, content: 'Άρθρο 57', similarity: 0.91 }];

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://cache.test:6379';
    db.query.mockResolvedValue({ rows });
    ollamaService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('caches a successful non-empty retrieval with TTL 300 and reuses it for an equivalent query', async () => {
    const store = new Map();
    mockGet.mockImplementation(async (key) => (store.has(key) ? store.get(key) : null));
    mockSet.mockImplementation(async (key, value) => {
      store.set(key, value);
      return 'OK';
    });

    const first = await ragService.retrieveContext('Νόμος   4622/2019');
    const second = await ragService.retrieveContext('  νόμος 4622/2019 ');

    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
    expect(ollamaService.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledTimes(1);

    const [key, payload, mode, ttl] = mockSet.mock.calls[0];
    expect(key).toMatch(/^nomos:cache:rag:context:[a-f0-9]{64}:5$/);
    expect(JSON.parse(payload)).toEqual(rows);
    expect(mode).toBe('EX');
    expect(ttl).toBe(300);
  });

  it('does not cache empty retrievals', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(ragService.retrieveContext('unknown')).resolves.toEqual([]);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('still returns fresh results when the cache read fails', async () => {
    mockGet.mockRejectedValue(errorWithCode('cache down', 'ECONNREFUSED'));

    await expect(ragService.retrieveContext('fallback')).resolves.toEqual(rows);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
