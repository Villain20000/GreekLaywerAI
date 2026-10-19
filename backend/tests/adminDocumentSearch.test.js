// Admin document search + pagination coverage for GET /api/admin/documents.
//
// Pins the additive `{ documents, total, limit, offset }` contract: every
// filter is bound as a parameter (never interpolated), inputs are clamped,
// and the legacy `documents` array keeps its shape (including chunk_count).
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');

const JWT_SECRET = 'nomos-super-secret-key-development';

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 99,
      email: overrides.email ?? 'admin@nomos.ai',
      role: overrides.role ?? 'admin',
      subscription_tier: overrides.subscription_tier ?? 'enterprise',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1,
      verified_at: new Date('2026-01-01T00:00:00Z')
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function adminToken(id = 99) {
  return jwt.sign({ id, email: 'admin@nomos.ai', role: 'admin', tv: 1 }, JWT_SECRET);
}

function documentRow(overrides = {}) {
  return {
    id: 11,
    user_id: 5,
    user_email: 'owner@nomos.ai',
    filename: 'contract.pdf',
    title: 'Contract',
    content_type: 'application/pdf',
    file_size: 2048,
    metadata: {},
    created_at: '2026-01-02T00:00:00.000Z',
    chunk_count: 4,
    ...overrides
  };
}

describe('Admin document search (GET /api/admin/documents)', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/admin/documents');
    expect(res.statusCode).toEqual(401);
  });

  it('should 403 for a non-admin', async () => {
    queueAuth({ id: 2, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic' });
    const res = await request(app)
      .get('/api/admin/documents')
      .set('Authorization', `Bearer ${adminToken(2)}`);
    expect(res.statusCode).toEqual(403);
  });

  it('should parameterize q + userId and return total/limit/offset', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [documentRow()] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 7 }] });

    const res = await request(app)
      .get('/api/admin/documents?q=contract&userId=5&limit=10&offset=20')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0]).toEqual(expect.objectContaining({
      filename: 'contract.pdf',
      title: 'Contract',
      file_size: 2048,
      chunk_count: 4
    }));
    expect(res.body.total).toBe(7);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).toMatch(/d\.file_size/);
    expect(pageSql).toMatch(/d\.title/);
    expect(pageSql).toMatch(/d\.user_id = \$1/);
    expect(pageSql).toMatch(/\(d\.filename ILIKE \$2 OR d\.title ILIKE \$2 OR u\.email ILIKE \$2\)/);
    expect(pageSql).toMatch(/LIMIT \$3 OFFSET \$4/);
    expect(pageParams).toEqual([5, '%contract%', 10, 20]);

    const [countSql, countParams] = db.query.mock.calls[2];
    expect(countSql).toMatch(/COUNT\(\*\)::int AS total/);
    expect(countSql).toMatch(/FROM legal_documents d/);
    expect(countSql).toMatch(/d\.user_id = \$1/);
    expect(countSql).toMatch(/d\.filename ILIKE \$2/);
    expect(countParams).toEqual([5, '%contract%']);
  });

  it('should default to limit 20 offset 0 and omit filters when absent', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = await request(app)
      .get('/api/admin/documents')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ documents: [], total: 0, limit: 20, offset: 0 });

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).not.toMatch(/ILIKE|WHERE d\./);
    expect(pageSql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(pageParams).toEqual([20, 0]);

    const [countSql, countParams] = db.query.mock.calls[2];
    expect(countSql).not.toMatch(/WHERE/);
    expect(countParams).toEqual([]);
  });

  it('should clamp limit/offset and ignore malformed userId', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = await request(app)
      .get('/api/admin/documents?limit=9999&offset=-5&userId=abc')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(0);

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).not.toMatch(/WHERE d\.user_id/);
    expect(pageParams).toEqual([100, 0]);
  });

  it('should clamp limit 0 to 1 and a negative userId is dropped', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = await request(app)
      .get('/api/admin/documents?limit=0&userId=-3')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.limit).toBe(1);

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).not.toMatch(/WHERE d\.user_id/);
    expect(pageParams).toEqual([1, 0]);
  });

  it('should trim q and cap it at 255 characters', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const longQuery = `  ${'x'.repeat(300)}  `;
    const res = await request(app)
      .get('/api/admin/documents')
      .query({ q: longQuery })
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);

    const [, pageParams] = db.query.mock.calls[1];
    expect(pageParams[0]).toBe(`%${'x'.repeat(255)}%`);
    expect(pageParams[0]).toHaveLength(257);
  });

  it('should never interpolate raw q into the SQL text', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const injection = "' OR 1=1 --";
    const res = await request(app)
      .get('/api/admin/documents')
      .query({ q: injection })
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).not.toContain(injection);
    expect(pageSql).not.toMatch(/OR 1=1/);
    expect(pageParams).toEqual([`%${injection}%`, 20, 0]);

    const [countSql, countParams] = db.query.mock.calls[2];
    expect(countSql).not.toContain(injection);
    expect(countParams).toEqual([`%${injection}%`]);
  });

  it('should fall back to total 0 when the count row is missing', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [documentRow()] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/admin/documents?userId=5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.total).toBe(0);
  });
});
