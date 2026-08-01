// Phase 29: Subscriptions + GDPR API tests.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');

const JWT_SECRET = 'nomos-super-secret-key-development';

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'basic',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1,
      verified_at: new Date('2026-01-01T00:00:00Z')
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

describe('Subscriptions API (/api/subscriptions)', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/subscriptions');
    expect(res.statusCode).toEqual(401);
  });

  it('should return the current subscription and live tier', async () => {
    queueAuth({ id: 2, subscription_tier: 'pro' });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, status: 'active', stripe_subscription_id: 'sub_1', current_period_end: '2026-08-01', created_at: '2026-01-01' }]
    });

    const res = await request(app)
      .get('/api/subscriptions')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.tier).toBe('pro');
    expect(res.body.subscription.status).toBe('active');
  });

  it('should list subscription history', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

    const res = await request(app)
      .get('/api/subscriptions/history')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.subscriptions).toHaveLength(2);
  });

  it('should 404 on cancel when the user has no subscription', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/subscriptions/cancel')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(404);
  });

  it('should cancel the current subscription at period end', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, stripe_subscription_id: 'sub_1', status: 'active' }]
    });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/subscriptions/cancel')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.subscription.status).toBe('canceled_at_period_end');
    const updateSql = db.query.mock.calls[2][0];
    expect(updateSql).toMatch(/UPDATE subscriptions SET status/);
  });

  it('should 400 on upgrade with an invalid tier', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .post('/api/subscriptions/upgrade')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ tier: 'platinum' });
    expect(res.statusCode).toEqual(400);
  });

  it('should create a checkout session on upgrade (mock mode URL)', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .post('/api/subscriptions/upgrade')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ tier: 'enterprise' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.url).toContain('tier=enterprise');
  });
});

describe('GDPR API (/api/gdpr)', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/gdpr/export');
    expect(res.statusCode).toEqual(401);
  });

  it('should export all user data', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 2, email: 'user@nomos.ai' }] });      // profile
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, title: 'c1', messages: [] }] });   // conversations
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, filename: 'a.pdf' }] });           // documents
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'active' }] });            // subscriptions
    db.query.mockResolvedValueOnce({ rows: [{ action: 'account.deleted' }] });          // audit
    db.query.mockResolvedValueOnce({ rows: [{ message_id: 4, helpful: true }] });        // feedback

    const res = await request(app)
      .get('/api/gdpr/export')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.user.email).toBe('user@nomos.ai');
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.audit_log).toHaveLength(1);
    expect(res.body.message_feedback).toHaveLength(1);
    // Export must run 6 queries (profile + 5 collections).
    expect(db.query).toHaveBeenCalledTimes(7); // 1 authMiddleware + 6 export
  });

  it('should reject account deletion without confirm:true', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .delete('/api/gdpr/account')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ confirm: false, email: 'user@nomos.ai' });
    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/confirm/i);
  });

  it('should reject account deletion when the email does not match', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .delete('/api/gdpr/account')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ confirm: true, email: 'other@nomos.ai' });
    expect(res.statusCode).toEqual(400);
  });

  it('should delete the user account (cascades handled by FKs)', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .delete('/api/gdpr/account')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ confirm: true, email: 'user@nomos.ai' });

    expect(res.statusCode).toEqual(200);
    const deleteCall = db.query.mock.calls.find(([sql]) => /DELETE FROM users WHERE id = \$1/.test(sql));
    expect(deleteCall).toBeDefined();
  });
});
