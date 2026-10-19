// Phase 34 regression lock: ragService's top-K default must be 5.
//
// This file enforces TWO unrelated invariants that together prove
// "the chat routes forward top-K=5 to the LLM":
//
//   1. The chat routes call `retrieveContext(prompt)` with NO explicit
//      second argument, so they inherit ragService's default. If a
//      future refactor writes `retrieveContext(prompt, 3)` to bypass
//      the default, test #1 fails.
//   2. ragService's default parameter is literally `5`. If someone
//      edits `backend/src/services/ragService.js` and reverts
//      `limit = 5` to `limit = 3`, test #2 + #3 fail.
//
// Test #3 verifies the SQL-level contract — that the inherited 5 is
// actually bound to the pgvector LIMIT placeholder, not silently
// dropped. This catches lazy fixes like `limit = 5` in the signature
// but no semantic forwarding.

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const ragService = require('../src/services/ragService');

const JWT_SECRET = 'nomos-super-secret-key-development';

// Mint a Bearer token compatible with the existing api.test.js fixtures
// (role=user so /api/ai/query is allowed by RBAC, tv=1 so authMiddleware
// accepts the token).
function userToken() {
  return jwt.sign(
    { id: 2, email: 'user@nomos.ai', role: 'user', tv: 1 },
    JWT_SECRET
  );
}

// Queue authMiddleware's user lookup so the JWT gets accepted. Each
// test call needs a fresh queue because authMiddleware consumes one
// db.query call per request.
function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'basic',
      created_at: overrides.created_at ?? new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1
    }]
  });
  // Fallback default for any further handler-internal db.query.
  db.query.mockResolvedValue({ rows: [] });
}

describe('ragService top-K default (Phase 34 regression lock)', () => {
  // The harness in tests/app.js pre-installs a ragService mock with
  // `retrieveContext: jest.fn().mockResolvedValue([{ content: 'Mock context' }])`.
  // We reset + re-mock per test so call counts and recorded args are
  // scoped cleanly.
  afterEach(() => {
    db.query.mockReset();
    ragService.retrieveContext.mockReset();
  });

  describe('chat routes infer top-K from ragService default', () => {
    it('POST /api/ai/query calls retrieveContext with NO explicit limit override', async () => {
      queueAuth({ id: 2, role: 'user' });
      ragService.retrieveContext.mockResolvedValue([{ content: 'Mock context' }]);

      const res = await request(app)
        .post('/api/ai/query')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ prompt: 'Τι είναι ο Αστικός Κώδικας;' });

      expect(res.statusCode).toEqual(200);
      expect(ragService.retrieveContext).toHaveBeenCalledTimes(1);

      // The critical invariant: the route called retrieveContext with
      // either no second arg, OR a second arg equal to `undefined`
      // (the variadic-tolerant form). A future refactor that writes
      // `retrieveContext(prompt, 3)` (or any non-default second arg)
      // silently regresses the top-K — this assertion catches it.
      const callArgs = ragService.retrieveContext.mock.calls[0];
      expect(callArgs.length === 1 || callArgs[1] === undefined).toBe(true);
      expect(callArgs[0]).toBe('Τι είναι ο Αστικός Κώδικας;');
    });

    it('POST /api/ai/query/stream calls retrieveContext with NO explicit limit override', async () => {
      queueAuth({ id: 2, role: 'user' });
      ragService.retrieveContext.mockResolvedValue([{ content: 'Mock context' }]);

      const res = await request(app)
        .post('/api/ai/query/stream')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ prompt: 'Νόμος 4622/2019' });

      expect(res.statusCode).toEqual(200);
      expect(ragService.retrieveContext).toHaveBeenCalledTimes(1);

      const callArgs = ragService.retrieveContext.mock.calls[0];
      expect(callArgs.length === 1 || callArgs[1] === undefined).toBe(true);
      expect(callArgs[0]).toBe('Νόμος 4622/2019');
    });

    it('POST /api/ai/audio-query (enterprise tier) calls retrieveContext with NO explicit limit override', async () => {
      const entToken = jwt.sign(
        { id: 1, email: 'ent@nomos.ai', role: 'enterprise', tv: 1 },
        JWT_SECRET
      );
      queueAuth({ id: 1, role: 'enterprise', subscription_tier: 'enterprise' });
      ragService.retrieveContext.mockResolvedValue([{ content: 'Mock context' }]);

      const res = await request(app)
        .post('/api/ai/audio-query')
        .set('Authorization', `Bearer ${entToken}`)
        .attach('audio', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('fake')]), 'test.webm');

      expect(res.statusCode).toEqual(200);
      expect(ragService.retrieveContext).toHaveBeenCalledTimes(1);

      // The audio-query route forwards the whisper transcript as the
      // retrieval query — we don't assert on the value here, only on no
      // explicit limit override.
      const callArgs = ragService.retrieveContext.mock.calls[0];
      expect(callArgs.length === 1 || callArgs[1] === undefined).toBe(true);
    });

    it('POST /api/ai/query with useRag=false does NOT call retrieveContext at all', async () => {
      queueAuth({ id: 2, role: 'user' });

      const res = await request(app)
        .post('/api/ai/query')
        .set('Authorization', `Bearer ${userToken()}`)
        .send({ prompt: 'plain LLM, no RAG', useRag: false });

      expect(res.statusCode).toEqual(200);
      expect(ragService.retrieveContext).not.toHaveBeenCalled();
    });
  });

  // Phase 34 SQL-introspection tests call the REAL retrieveContext
  // (via jest.requireActual) — tests/app.js mocks the module with a
  // jest.fn() that returns a static array and never calls db.query,
  // so any spy on the mocked function would not exercise the actual
  // limit-binding SQL path. Using requireActual keeps the harness's
  // OTHER mocks (ollamaService.generateEmbedding, db.query) in effect
  // while running the real ragService implementation underneath.
  describe('ragService default parameter reflects top-K=5', () => {
    // Phase 34 lock: ragService.js MUST declare `limit = 5` as the
    // function-default parameter. A grep-friendly string assertion via
    // .toString() on the actual function source avoids importing the
    // source file or running a code parser. If someone reverts the
    // default to `limit = 3`, this fails.
    it('ragService.retrieveContext function signature declares limit=5', () => {
      const ragServiceReal = jest.requireActual('../src/services/ragService');
      const sig = ragServiceReal.retrieveContext.toString();
      // Match `limit = 5` anywhere in the declaration line; tolerant of
      // whitespace and JSDoc above the signature.
      expect(sig).toMatch(/\blimit\s*=\s*5\b/);
      // And explicitly NOT 3 — defends against an accidental re-paste of
      // the old Phase 31 default.
      expect(sig).not.toMatch(/\blimit\s*=\s*3\b/);
    });

    it('calling retrieveContext with 1 arg forwards limit=5 to the pgvector LIMIT placeholder', async () => {
      // Use the unmocked ragService so the real implementation runs
      // through its SQL path (the harness's mock skips db.query).
      const ragServiceReal = jest.requireActual('../src/services/ragService');
      const ollamaService = require('../src/services/ollamaService');
      ollamaService.generateEmbedding.mockResolvedValueOnce([0.5, 0.6, 0.7]);
      // Seed db.query with the shape retrieveContext reads (`result.rows`).
      db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      await ragServiceReal.retrieveContext('test prompt');

      expect(db.query).toHaveBeenCalledTimes(1);
      const sql = db.query.mock.calls[0][0];
      const params = db.query.mock.calls[0][1];

      expect(sql).toMatch(/ORDER BY embedding <=>\s*\$1::vector/);
      expect(sql).toMatch(/LIMIT\s*\$2/);
      // Inspect the bind array. params[0] is the embedding string;
      // params[1] is the limit. Must be exactly 5.
      // NOTE: ragService.js binds positionally as `[embeddingStr, limit]`.
      // If a future refactor switches to pg's named-bind syntax the params
      // shape changes; the assertion will reflag in CI then.
      expect(Array.isArray(params)).toBe(true);
      expect(params.length).toBeGreaterThanOrEqual(2);
      expect(params[1]).toBe(5);
    });

    it('calling retrieveContext with explicit limit=5 keeps the same SQL wire contract', async () => {
      // Belt-and-suspenders: if someone writes `retrieveContext(prompt, 5)`
      // (instead of relying on the default), the SQL must still bind 5.
      const ragServiceReal = jest.requireActual('../src/services/ragService');
      const ollamaService = require('../src/services/ollamaService');
      ollamaService.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
      db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      await ragServiceReal.retrieveContext('test prompt', 5);

      const params = db.query.mock.calls[0][1];
      expect(params[1]).toBe(5);
    });
  });
});
