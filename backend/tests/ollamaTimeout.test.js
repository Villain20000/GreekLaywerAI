// Phase 1-2: outbound Ollama HTTP timeout (OLLAMA_TIMEOUT_MS).
//
// ollamaService injects an AbortSignal.timeout() into the ollama-js client's
// custom fetch, so a hung Ollama (cold load / paging / wedged process) aborts
// instead of pinning the HTTP request or an inference worker slot forever.
// This suite mocks the ollama SDK at the module boundary (same pattern as
// tests/ollamaWarmup.test.js) and drives a REAL HTTP server that never
// responds, proving the abort actually fires.

const http = require('http');

let mockCapturedConfig = null;
let mockHangUrl = '';

// The fake client routes every call through the SAME fetch that
// ollamaService configures, so the timeout wrapper is exercised end-to-end
// (not just its construction).
jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation((config) => {
    mockCapturedConfig = config;
    return {
      embeddings: async () => {
        const response = await config.fetch(mockHangUrl, { method: 'POST' });
        return response.json();
      },
      chat: async () => {
        const response = await config.fetch(mockHangUrl, { method: 'POST' });
        return response.json();
      }
    };
  })
}));

function freshService() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/services/ollamaService');
  });
  return mod;
}

describe('ollamaService outbound timeout', () => {
  let hangServer;

  beforeAll((done) => {
    hangServer = http.createServer(() => {
      // Intentionally never respond: simulates a hung Ollama.
    });
    hangServer.listen(0, '127.0.0.1', () => {
      mockHangUrl = `http://127.0.0.1:${hangServer.address().port}/api/embeddings`;
      done();
    });
  });

  afterAll((done) => {
    if (typeof hangServer.closeAllConnections === 'function') {
      hangServer.closeAllConnections();
    }
    hangServer.close(done);
  });

  afterEach(() => {
    delete process.env.OLLAMA_TIMEOUT_MS;
  });

  it('aborts a hung embeddings call after OLLAMA_TIMEOUT_MS', async () => {
    process.env.OLLAMA_TIMEOUT_MS = '80';
    const svc = freshService();

    const startedAt = Date.now();
    await expect(svc.generateEmbedding('timeout test')).rejects.toMatchObject({
      name: 'TimeoutError'
    });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2000);
  });

  it('aborts a hung chat call after OLLAMA_TIMEOUT_MS', async () => {
    process.env.OLLAMA_TIMEOUT_MS = '80';
    const svc = freshService();

    await expect(svc.generateResponse('timeout test')).rejects.toMatchObject({
      name: 'TimeoutError'
    });
  });

  it('preserves a caller-provided AbortSignal (streaming abort path)', async () => {
    process.env.OLLAMA_TIMEOUT_MS = '60000';
    freshService();
    expect(mockCapturedConfig.fetch).toEqual(expect.any(Function));

    const controller = new AbortController();
    const pending = mockCapturedConfig.fetch(mockHangUrl, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the 120 s default when OLLAMA_TIMEOUT_MS is unset', async () => {
    freshService();

    const controller = new AbortController();
    const pending = mockCapturedConfig
      .fetch(mockHangUrl, { signal: controller.signal })
      .catch((err) => err);

    const outcome = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 60))
    ]);
    expect(outcome).toBe('pending');

    controller.abort();
    await pending;
  });
});
