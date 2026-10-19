// Phase 29: Conversations CRUD API.
//
// Every endpoint is scoped to req.user.id — a user can only ever see,
// edit, or delete their own conversations. Deleting a conversation
// cascades to its messages (FK ON DELETE CASCADE).

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');

// 1-3: per-user caps on the list/create hot paths (see rateLimiters.js).
const limiters = createApiRateLimiters();

const DEFAULT_TITLE = 'Νέα συνομιλία';

function parsePositiveInt(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET /api/conversations?limit=20&offset=0&q= — list user's conversations
//
// `q` is an optional case-insensitive title filter (parameterized — never
// interpolated into SQL). `total` is the full match count so the UI can
// paginate; the original `conversations` array shape is unchanged.
router.get('/', limiters.conversationList, async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 255) : '';

    const params = [req.user.id, limit, offset];
    let searchSql = '';
    if (q) {
      params.push(`%${q}%`);
      searchSql = ` AND title ILIKE $${params.length}`;
    }

    // COUNT(*) OVER() returns the total across the filtered set in the same
    // round-trip as the page, so an empty page simply reports 0.
    const result = await db.query(
      `SELECT id, title, created_at, updated_at, COUNT(*) OVER() AS total_count
       FROM conversations
       WHERE user_id = $1${searchSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      params
    );
    const conversations = result.rows.map(({ total_count, ...conversation }) => conversation);
    const rawTotal = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
    const total = Number.isFinite(rawTotal) ? rawTotal : result.rows.length;
    res.json({ conversations, total });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/conversations — create (title optional, auto-generated)
router.post(
  '/',
  limiters.conversationCreate,
  validate([check('title').optional({ values: 'null' }).isString().isLength({ max: 255 })]),
  async (req, res) => {
    try {
      const title = (req.body && req.body.title ? String(req.body.title) : '').trim() || DEFAULT_TITLE;
      const result = await db.query(
        `INSERT INTO conversations (user_id, title)
         VALUES ($1, $2)
         RETURNING id, title, created_at, updated_at`,
        [req.user.id, title]
      );
      res.status(201).json({ conversation: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// GET /api/conversations/:id — conversation + messages
router.get('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid conversation id' });

    const conv = await db.query(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const msgs = await db.query(
      `SELECT m.id, m.role, m.content, m.citation_metadata, m.created_at,
              mf.helpful AS feedback_helpful
       FROM messages m
       LEFT JOIN message_feedback mf
         ON mf.message_id = m.id AND mf.user_id = $2
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC, m.id ASC`,
      [id, req.user.id]
    );
    res.json({ conversation: conv.rows[0], messages: msgs.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/conversations/:id — rename
router.put(
  '/:id',
  validate([check('title').isString().trim().notEmpty().withMessage('title is required').isLength({ max: 255 })]),
  async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id === null) return res.status(400).json({ error: 'Invalid conversation id' });

      const result = await db.query(
        `UPDATE conversations
         SET title = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND user_id = $3
         RETURNING id, title, created_at, updated_at`,
        [req.body.title.trim(), id, req.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      res.json({ conversation: result.rows[0] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

// DELETE /api/conversations/:id — conversation + messages cascade
router.delete('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid conversation id' });

    const result = await db.query(
      `DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json({ ok: true, deletedId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
