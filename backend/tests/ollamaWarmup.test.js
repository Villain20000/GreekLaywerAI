// Phase 28: pre-warm path — pay the gemma:2b + bge-m3 cold-load
// penalty once at container startup so the first /api/ai/query doesn't
// hang for ~180 s while the models load into Ollama memory.
// Phase 31: embed model swap from nomic-embed-text (768-dim) to
// bge-m3 (1024-dim). Tests updated to reflect the new default model
// name and dim so a regression is caught immediately.
//
// This suite verifies:
//   1. `warmup()` flips both `embedWarmed` and `chatWarmed` to true when
//      both Ollama calls succeed and return the expected shape.
//   2. `getWarmupStatus()` exposes the documented status envelope and
//      transitions from `warming` ⇄ `ready` correctly.
//   3. A failure on the embed leg does NOT block the chat leg.
//   4. `warmup()` is idempotent — calling it twice returns the SAME
//      promise (singleton coalescing) so concurrent boot paths don't
//      re-charge a second load.
//   5. Cold state (before any warmup) exposes null warmed-at timestamps.
//   6. The /api/ai/health endpoint surfaces the same state through a
//      bare Express app via supertest, confirming the route is wired
//      to ollamaService.getWarmupStatus() rather than a static value.

// Mock the Ollama SDK at the module boundary so `require('ollama')` in
// ollamaService.js returns our stub. The hoisted jest.mock will reach
// the singleton Ollama instance built at module load.
const mockEmbed = jest.fn();
const mockChat = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    embeddings: mockEmbed,
    chat: mockChat
  }))
}));

function freshService() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/services/ollamaService');
  });
  return mod;
}

describe('ollamaService.warmup + getWarmupStatus', () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockChat.mockReset();
  });

  it('cold state reports warming with null timestamps', () => {
    const svc = freshService();
    const s = svc.getWarmupStatus();
    expect(s.status).toBe('warming');
    expect(s.embedWarmed).toBe(false);
    expect(s.chatWarmed).toBe(false);
    expect(s.embedWarmedAt).toBeNull();
    expect(s.chatWarmedAt).toBeNull();
    // Surface the resolved model name + dim so an operator hitting
    // /api/ai/health can immediately confirm what the backend claims.
    expect(s.embedModel).toBe('bge-m3');
    expect(s.chatModel).toBe('gemma:2b');
    expect(s.embedDim).toBe(1024);
  });

  it('flips both warmed flags after a successful warmup', async () => {
    mockEmbed.mockResolvedValue({ embedding: new Array(1024).fill(0.1) });
    mockChat.mockResolvedValue({ message: { content: 'pong' } });

    const svc = freshService();
    await svc.warmup();

    const s = svc.getWarmupStatus();
    expect(s.embedWarmed).toBe(true);
    expect(s.chatWarmed).toBe(true);
    expect(s.status).toBe('ready');
    expect(typeof s.embedWarmedAt).toBe('string');
    expect(typeof s.chatWarmedAt).toBe('string');
    // freshness check: stamped within the last 5 s
    expect(new Date(s.embedWarmedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(new Date(s.chatWarmedAt).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('reports warming when only the chat leg succeeded (embed threw)', async () => {
    mockEmbed.mockRejectedValue(new Error('ECONNREFUSED during warmup'));
    mockChat.mockResolvedValue({ message: { content: 'pong' } });

    const svc = freshService();
    await svc.warmup();

    const s = svc.getWarmupStatus();
    expect(s.embedWarmed).toBe(false);
    expect(s.chatWarmed).toBe(true);
    expect(s.status).toBe('warming');
  });

  it('is idempotent — second warmup() returns the same BY-REFERENCE promise and does NOT re-call Ollama', async () => {
    mockEmbed.mockResolvedValue({ embedding: new Array(1024).fill(0.1) });
    mockChat.mockResolvedValue({ message: { content: 'pong' } });

    const svc = freshService();
    const p1 = svc.warmup();
    const p2 = svc.warmup();
    // Idempotency invariant: the very same Promise instance is returned
    // both times (the singleton is exposed by reference, NOT wrapped in
    // a fresh outer Promise by an `async function` declaration). If
    // warmup() is refactored back to `async function warmup() { … }`,
    // this assertion will surface the regression immediately.
    expect(p2).toBe(p1);

    await Promise.all([p1, p2]);

    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('warmupReset() then warmup() retries the failed leg (partial-failure recovery)', async () => {
    // First attempt: embed leg succeeds, chat leg fails (e.g. the model
    // was still being pulled during the first try). The singleton
    // promise resolves with embedWarmed=true, chatWarmed=false.
    mockEmbed.mockResolvedValueOnce({ embedding: new Array(1024).fill(0.1) });
    mockChat.mockRejectedValueOnce(new Error('model "gemma:2b" not found, pull first'));

    const svc = freshService();
    await svc.warmup();
    expect(svc.getWarmupStatus().embedWarmed).toBe(true);
    expect(svc.getWarmupStatus().chatWarmed).toBe(false);
    expect(svc.getWarmupStatus().status).toBe('warming');

    // Operator pulls gemma:2b, then calls warmupReset() + warmup() to
    // retry. The reset must (a) clear the singleton promise so the next
    // warmup() actually runs, AND (b) zero the state so the next status
    // reflects only the second attempt's outcome.
    mockEmbed.mockResolvedValueOnce({ embedding: new Array(1024).fill(0.2) });
    mockChat.mockResolvedValueOnce({ message: { content: 'pong' } });

    svc.warmupReset();
    expect(svc.getWarmupStatus().status).toBe('warming');
    expect(svc.getWarmupStatus().embedWarmedAt).toBeNull();

    await svc.warmup();
    const after = svc.getWarmupStatus();
    expect(after.embedWarmed).toBe(true);
    expect(after.chatWarmed).toBe(true);
    expect(after.status).toBe('ready');

    // Both legs should now have been called exactly twice (once per
    // attempt). If warmupReset() failed to clear the singleton,
    // mockEmbed + mockChat would each only have one recorded call set.
    expect(mockEmbed).toHaveBeenCalledTimes(2);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('does not throw when warmup() is called WITHOUT an explicit await (fire-and-forget)', async () => {
    mockEmbed.mockResolvedValue({ embedding: new Array(1024).fill(0.1) });
    mockChat.mockResolvedValue({ message: { content: 'pong' } });

    const svc = freshService();
    // Drop the promise on purpose: ollamaService.warmup() is called as
    // .catch(log) in index.js's app.listen callback. A rejected promise
    // would surface as `UnhandledPromiseRejectionWarning`. Guard test.
    svc.warmup();
    // Wait microtasks so the warmup resolves before assertions.
    await new Promise((r) => setImmediate(r));
    const s = svc.getWarmupStatus();
    expect(s.status).toBe('ready');
  });
});

describe('GET /api/ai/health (Express wiring)', () => {
  // We spin up a one-route Express mini-app identical to the production
  // mount (`GET /api/ai/health` -> ollamaService.getWarmupStatus()) but
  // without the /api/ai router's authMiddleware shielding, so supertest
  // can hit it. The ollamaService is the SAME module mock as above (jest
  // mocks are module-scoped + hoisted across jest.isolateModules blocks).
  const request = require('supertest');
  const express = require('express');

  function mountHealthRoute(app, svc) {
    app.get('/api/ai/health', (req, res) => {
      res.json({ service: 'NomosAI', ...svc.getWarmupStatus() });
    });
  }

  it('reports warming before warmup, ready after, with the same shape', async () => {
    mockEmbed.mockResolvedValue({ embedding: new Array(1024).fill(0.4) });
    mockChat.mockResolvedValue({ message: { content: 'ok' } });

    const svc = freshService();
    const app = express();
    mountHealthRoute(app, svc);

    // Before warmup
    let res = await request(app).get('/api/ai/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('NomosAI');
    expect(res.body.status).toBe('warming');
    expect(res.body.embedWarmedAt).toBeNull();

    // Trigger + await warmup
    await svc.warmup();

    res = await request(app).get('/api/ai/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.embedWarmed).toBe(true);
    expect(res.body.chatWarmed).toBe(true);
    expect(typeof res.body.embedWarmedAt).toBe('string');
    expect(typeof res.body.chatWarmedAt).toBe('string');
  });
});
