// Cursor pagination for GET /api/conversations/:id.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');

const JWT_SECRET = 'nomos-super-secret-key-development';

function queueAuth() {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: 2,
      email: 'user@nomos.ai',
      role: 'user',
      subscription_tier: 'basic',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken() {
  return jwt.sign({ id: 2, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

function queueConversation() {
  db.query.mockResolvedValueOnce({
    rows: [{ id: 1, title: 'Συνομιλία', created_at: '2026-01-01', updated_at: '2026-01-01' }]
  });
}

function message(id) {
  return {
    id,
    role: id % 2 === 0 ? 'assistant' : 'user',
    content: `μήνυμα ${id}`,
    citation_metadata: {},
    created_at: '2026-01-01',
    feedback_helpful: null
  };
}

function get(path) {
  return request(app)
    .get(path)
    .set('Authorization', `Bearer ${userToken()}`);
}

describe('GET /api/conversations/:id message pagination', () => {
  afterEach(() => {
    db.query.mockReset();
  });

  it('keeps returning all messages ascending when messageLimit is absent', async () => {
    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [message(1), message(2)] });

    const res = await get('/api/conversations/1');

    expect(res.statusCode).toEqual(200);
    expect(res.body.messages.map((m) => m.id)).toEqual([1, 2]);
    // Original response shape: pagination metadata is only sent on request.
    expect(res.body.hasMore).toBeUndefined();
    expect(res.body.nextCursor).toBeUndefined();

    const sql = db.query.mock.calls[2][0];
    expect(sql).toMatch(/ORDER BY m\.created_at ASC, m\.id ASC/);
    expect(sql).not.toMatch(/LIMIT/);
  });

  it('returns the newest page plus hasMore and nextCursor', async () => {
    queueAuth();
    queueConversation();
    // Requested limit 2, route fetches 3 (DESC), so an older row exists.
    db.query.mockResolvedValueOnce({ rows: [message(12), message(11), message(10)] });

    const res = await get('/api/conversations/1?messageLimit=2');

    expect(res.statusCode).toEqual(200);
    expect(res.body.messages.map((m) => m.id)).toEqual([11, 12]);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toBe(11);

    const [sql, params] = db.query.mock.calls[2];
    expect(sql).toMatch(/ORDER BY m\.id DESC/);
    expect(sql).toMatch(/LIMIT \$3/);
    expect(params).toEqual([1, 2, 3]);
  });

  it('uses before as an exclusive upper bound and reports the oldest returned id', async () => {
    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [message(9), message(8)] });

    const res = await get('/api/conversations/1?messageLimit=2&before=10');

    expect(res.statusCode).toEqual(200);
    expect(res.body.messages.map((m) => m.id)).toEqual([8, 9]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe(8);

    const [sql, params] = db.query.mock.calls[2];
    expect(sql).toMatch(/m\.id < \$3/);
    expect(sql).toMatch(/LIMIT \$4/);
    expect(params).toEqual([1, 2, 10, 3]);
    // Feedback stays scoped to the caller through the LEFT JOIN.
    expect(sql).toMatch(/LEFT JOIN message_feedback/);
    expect(sql).toMatch(/mf\.user_id = \$2/);
  });

  it('reports hasMore=false when exactly messageLimit rows are returned', async () => {
    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [message(3), message(2)] });

    const res = await get('/api/conversations/1?messageLimit=2&before=4');

    expect(res.statusCode).toEqual(200);
    expect(res.body.messages.map((m) => m.id)).toEqual([2, 3]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe(2);
  });

  it('returns an empty page with a null cursor', async () => {
    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await get('/api/conversations/1?messageLimit=50&before=1');

    expect(res.statusCode).toEqual(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it.each([
    'messageLimit=0',
    'messageLimit=101',
    'messageLimit=abc',
    'messageLimit=1.5',
    'messageLimit=',
    'messageLimit=5&before=0',
    'messageLimit=5&before=-2',
    'messageLimit=5&before=abc',
    'messageLimit=5&before=1.5',
    'messageLimit=5&before=2147483648',
    'before=0'
  ])('rejects invalid pagination input (%s) with 400', async (query) => {
    queueAuth();
    const res = await get(`/api/conversations/1?${query}`);

    expect(res.statusCode).toEqual(400);
    expect(db.query).toHaveBeenCalledTimes(1); // auth only
  });

  it('accepts the boundaries 1 and 100', async () => {
    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [message(1)] });
    let res = await get('/api/conversations/1?messageLimit=1');
    expect(res.statusCode).toEqual(200);

    queueAuth();
    queueConversation();
    db.query.mockResolvedValueOnce({ rows: [] });
    res = await get('/api/conversations/1?messageLimit=100');
    expect(res.statusCode).toEqual(200);
  });
});
