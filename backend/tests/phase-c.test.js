const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const inferenceQueue = require('../src/services/inferenceQueue');

const JWT_SECRET = 'nomos-super-secret-key-development';

function token(id = 2, role = 'user') {
  return jwt.sign({ id, email: `${role}@nomos.ai`, role, tv: 1 }, JWT_SECRET);
}

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'basic',
      created_at: new Date('2026-01-01T00:00:00Z'),
      token_version: 1,
      verified_at: new Date('2026-01-01T00:00:00Z')
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

describe('Phase C answer feedback', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('accepts feedback only for an owned assistant message and upserts one signal', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 42 }] });
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 7,
        message_id: 42,
        user_id: 2,
        helpful: false,
        reason: 'Δεν απάντησε στο συγκεκριμένο άρθρο',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z'
      }]
    });

    const res = await request(app)
      .post('/api/ai/messages/42/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ helpful: false, reason: 'Δεν απάντησε στο συγκεκριμένο άρθρο' });

    expect(res.statusCode).toBe(200);
    expect(res.body.feedback.helpful).toBe(false);
    expect(db.query.mock.calls[2][0]).toMatch(/ON CONFLICT \(message_id, user_id\) DO UPDATE/);
    expect(db.query.mock.calls[2][1]).toEqual([42, 2, false, 'Δεν απάντησε στο συγκεκριμένο άρθρο']);
  });

  it('does not reveal or write feedback for another user or a user message', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/ai/messages/99/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ helpful: true });

    expect(res.statusCode).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('validates helpful and reason before touching the database', async () => {
    queueAuth({ id: 2 });

    const res = await request(app)
      .post('/api/ai/messages/42/feedback')
      .set('Authorization', `Bearer ${token()}`)
      .send({ helpful: 'yes', reason: 'x'.repeat(501) });

    expect(res.statusCode).toBe(400);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('returns the same assistant message id when a completed job is polled twice', async () => {
    const completedJob = {
      data: { userId: 2, conversationId: 7, prompt: 'ερώτηση', sources: [], confidence: 0.8 },
      returnvalue: 'απάντηση',
      getState: jest.fn().mockResolvedValue('completed')
    };
    inferenceQueue.getJob.mockResolvedValue(completedJob);

    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    db.query.mockResolvedValueOnce({ rows: [{ assistant_message_id: 42 }] });
    const first = await request(app)
      .get('/api/ai/query/stream/job-42')
      .set('Authorization', `Bearer ${token()}`);

    db.query.mockResolvedValueOnce({
      rows: [{ id: 2, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic', token_version: 1, verified_at: new Date() }]
    });
    db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    db.query.mockResolvedValueOnce({ rows: [{ assistant_message_id: 42 }] });
    const second = await request(app)
      .get('/api/ai/query/stream/job-42')
      .set('Authorization', `Bearer ${token()}`);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.body.messageId).toBe(42);
    expect(second.body.messageId).toBe(42);
  });

  it('returns an aggregate, content-free admin summary', async () => {
    queueAuth({ id: 99, role: 'admin', subscription_tier: 'enterprise' });
    db.query.mockResolvedValueOnce({
      rows: [{ total: '10', helpful: '7', unhelpful: '3', last_submitted_at: '2026-08-01T00:00:00Z' }]
    });

    const res = await request(app)
      .get('/api/admin/feedback-summary?days=14')
      .set('Authorization', `Bearer ${token(99, 'admin')}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      days: 14,
      total: 10,
      helpful: 7,
      unhelpful: 3,
      helpfulRate: 0.7,
      lastSubmittedAt: '2026-08-01T00:00:00Z'
    });
    expect(db.query.mock.calls[1][1]).toEqual([14]);
  });
});
