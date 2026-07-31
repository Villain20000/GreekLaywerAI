// Phase 29: Conversations CRUD API tests.
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
      token_version: overrides.token_version ?? 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

describe('Conversations API (/api/conversations)', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/conversations');
    expect(res.statusCode).toEqual(401);
  });

  it('should list the user\'s conversations with pagination', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 1, title: 'Αστικός Κώδικας', created_at: '2026-01-01', updated_at: '2026-01-02' }
      ]
    });

    const res = await request(app)
      .get('/api/conversations?limit=5&offset=0')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.conversations).toHaveLength(1);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
    expect(sql).toMatch(/ORDER BY updated_at DESC/);
  });

  it('should create a conversation with an auto-generated title when none given', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: 'Νέα συνομιλία', created_at: '2026-01-01', updated_at: '2026-01-01' }]
    });

    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({});

    expect(res.statusCode).toEqual(201);
    expect(res.body.conversation.title).toBe('Νέα συνομιλία');
    expect(db.query.mock.calls[1][1][1]).toBe('Νέα συνομιλία');
  });

  it('should 400 on a title longer than 255 chars', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ title: 'x'.repeat(256) });
    expect(res.statusCode).toEqual(400);
    expect(db.query).toHaveBeenCalledTimes(1); // only authMiddleware
  });

  it('should return a conversation with its messages', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: 'Τίτλος', created_at: '2026-01-01', updated_at: '2026-01-01' }]
    });
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 1, role: 'user', content: 'Ερώτηση', created_at: '2026-01-01' },
        { id: 2, role: 'assistant', content: 'Απάντηση', created_at: '2026-01-01' }
      ]
    });

    const res = await request(app)
      .get('/api/conversations/1')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.conversation.title).toBe('Τίτλος');
    expect(res.body.messages).toHaveLength(2);
  });

  it('should 404 when a conversation belongs to another user', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [] }); // ownership SELECT empty

    const res = await request(app)
      .get('/api/conversations/99')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(404);
  });

  it('should rename a conversation (PUT) scoped to the owner', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, title: 'Νέο όνομα', created_at: '2026-01-01', updated_at: '2026-01-01' }]
    });

    const res = await request(app)
      .put('/api/conversations/1')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ title: 'Νέο όνομα' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.conversation.title).toBe('Νέο όνομα');
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/WHERE id = \$2 AND user_id = \$3/);
  });

  it('should delete a conversation (messages cascade via FK)', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

    const res = await request(app)
      .delete('/api/conversations/1')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.ok).toBe(true);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/DELETE FROM conversations/);
  });
});
