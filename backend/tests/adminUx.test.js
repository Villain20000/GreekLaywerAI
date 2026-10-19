// 2-4: Admin UX backend coverage.
//
// Pins the additive search/pagination contract on GET /api/admin/users and
// the filter/pagination contract on GET /api/admin/audit-log. Both keep the
// legacy response keys (`users` / `auditLog`) and add `total` metadata.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const audit = require('../src/services/auditLog');

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

describe('Admin users search + pagination (GET /api/admin/users)', () => {
  afterEach(() => {
    db.query.mockReset();
    audit.getAuditLogs.mockClear();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/admin/users');
    expect(res.statusCode).toEqual(401);
  });

  it('should 403 for a non-admin', async () => {
    queueAuth({ id: 2, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic' });
    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken(2)}`);
    expect(res.statusCode).toEqual(403);
  });

  it('should parameterize q + limit/offset and return total', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' }]
    }); // users SELECT
    db.query.mockResolvedValueOnce({ rows: [{ total: 7 }] }); // COUNT

    const res = await request(app)
      .get('/api/admin/users?q=lawyer&limit=10&offset=20')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0].email).toBe('lawyer@nomos.ai');
    expect(res.body.total).toBe(7);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);

    // call[0] is authMiddleware; call[1] the page SELECT; call[2] the count.
    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).toMatch(/WHERE email ILIKE \$1/);
    expect(pageSql).toMatch(/LIMIT \$2 OFFSET \$3/);
    expect(pageParams).toEqual(['%lawyer%', 10, 20]);

    const [countSql, countParams] = db.query.mock.calls[2];
    expect(countSql).toMatch(/SELECT COUNT\(\*\)::int AS total FROM users WHERE email ILIKE \$1/);
    expect(countParams).toEqual(['%lawyer%']);
  });

  it('should clamp limit/offset and omit the WHERE clause without q', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const res = await request(app)
      .get('/api/admin/users?limit=9999&offset=-5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.limit).toBe(200);
    expect(res.body.offset).toBe(0);
    expect(res.body.total).toBe(0);

    const [pageSql, pageParams] = db.query.mock.calls[1];
    expect(pageSql).not.toMatch(/ILIKE/);
    expect(pageSql).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(pageParams).toEqual([200, 0]);
  });

  it('should keep the legacy users-only body shape when total is unavailable', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, email: 'u@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-01' }]
    });
    // No COUNT row → route falls back to 0, users still render.

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.total).toBe(0);
  });
});

describe('Admin audit-log viewer (GET /api/admin/audit-log)', () => {
  afterEach(() => {
    db.query.mockReset();
    audit.getAuditLogs.mockClear();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/admin/audit-log');
    expect(res.statusCode).toEqual(401);
  });

  it('should 403 for a non-admin', async () => {
    queueAuth({ id: 2, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic' });
    const res = await request(app)
      .get('/api/admin/audit-log')
      .set('Authorization', `Bearer ${adminToken(2)}`);
    expect(res.statusCode).toEqual(403);
  });

  it('should forward userId/action/limit/offset to getAuditLogs and return total', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ total: 3 }] }); // COUNT
    audit.getAuditLogs.mockResolvedValueOnce([
      {
        id: 10,
        user_id: 2,
        action: 'admin.role_changed',
        resource_type: 'user',
        resource_id: '2',
        created_at: '2026-01-01T00:00:00Z'
      }
    ]);

    const res = await request(app)
      .get('/api/admin/audit-log?userId=2&action=admin.role_changed&limit=10&offset=5')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.auditLog).toHaveLength(1);
    expect(res.body.auditLog[0].action).toBe('admin.role_changed');
    expect(res.body.total).toBe(3);
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(5);

    expect(audit.getAuditLogs).toHaveBeenCalledWith({
      userId: 2,
      action: 'admin.role_changed',
      limit: 10,
      offset: 5
    });

    const [countSql, countParams] = db.query.mock.calls[1];
    expect(countSql).toMatch(/FROM audit_log WHERE user_id = \$1 AND action = \$2/);
    expect(countParams).toEqual([2, 'admin.role_changed']);
  });

  it('should ignore malformed filters and default to 50/0', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({ rows: [{ total: 0 }] });
    audit.getAuditLogs.mockResolvedValueOnce([]);

    const res = await request(app)
      .get('/api/admin/audit-log?userId=abc&action=%20%20')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.total).toBe(0);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
    expect(audit.getAuditLogs).toHaveBeenCalledWith({
      userId: undefined,
      action: undefined,
      limit: 50,
      offset: 0
    });

    const [countSql, countParams] = db.query.mock.calls[1];
    expect(countSql).not.toMatch(/WHERE/);
    expect(countParams).toEqual([]);
  });
});
