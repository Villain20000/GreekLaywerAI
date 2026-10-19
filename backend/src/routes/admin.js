const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authMiddleware, rbacMiddleware, ALLOWED_ROLES, ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { logAudit, getAuditLogs } = require('../services/auditLog');

// All admin endpoints require auth AND admin role.
router.use(authMiddleware);
router.use(rbacMiddleware(['admin']));

// Shared positive-integer validation for every `:id` route param. The two
// aliases below keep call sites self-documenting (user id vs document id)
// while sharing one implementation.
function parsePositiveId(rawId) {
  const parsed = parseInt(rawId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

const parseUserId = parsePositiveId;
const parseDocumentId = parsePositiveId;

// GET /api/admin/users — list every user (without password).
//
// 2-4: optional search + pagination, backward compatible with the previous
// `{ users }`-only response. `q` matches the email case-insensitively;
// `limit`/`offset` are clamped to sane bounds. `total`, `limit`, and
// `offset` are additive so the UI can render a pager.
router.get('/users', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);

    // Search is parameterized (ILIKE) — never interpolate user input.
    const filterParams = q ? [`%${q}%`] : [];
    const where = q ? 'WHERE email ILIKE $1' : '';

    const result = await db.query(
      `SELECT id, email, role, subscription_tier, created_at
       FROM users
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset]
    );
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM users ${where}`,
      filterParams
    );
    const total = Number(countResult.rows[0] && countResult.rows[0].total) || 0;

    res.json({ users: result.rows, total, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/admin/users/:id/role — change a user's role
router.patch('/users/:id/role', async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const { role } = req.body;
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        error: `Invalid role. Must be one of: ${ALLOWED_ROLES.join(', ')}.`
      });
    }

    // Guard: don't let an admin demote themselves (would lock the system out of admins).
    if (userId === req.user.id && role !== 'admin') {
      return res.status(409).json({
        error: 'Refusing to demote yourself. Have another admin make the change.'
      });
    }

    // Capture the previous role for the audit trail BEFORE the UPDATE.
    const before = await db.query(
      `SELECT role FROM users WHERE id = $1`,
      [userId]
    );
    if (before.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await db.query(
      `UPDATE users SET role = $1 WHERE id = $2
       RETURNING id, email, role, subscription_tier`,
      [role, userId]
    );

    await logAudit({
      userId,
      action: 'admin.role_changed',
      resourceType: 'user',
      resourceId: userId,
      oldValue: { role: before.rows[0].role },
      newValue: { role },
      ipAddress: req.ip
    });

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /api/admin/users/:id/tier — change a user's billing tier
router.patch('/users/:id/tier', async (req, res) => {
  try {
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const { tier } = req.body;
    if (!ALLOWED_TIERS.includes(tier)) {
      return res.status(400).json({
        error: `Invalid tier. Must be one of: ${ALLOWED_TIERS.join(', ')}.`
      });
    }

    const before = await db.query(
      `SELECT subscription_tier FROM users WHERE id = $1`,
      [userId]
    );
    if (before.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await db.query(
      `UPDATE users SET subscription_tier = $1 WHERE id = $2
       RETURNING id, email, role, subscription_tier`,
      [tier, userId]
    );

    await logAudit({
      userId,
      action: 'admin.tier_changed',
      resourceType: 'user',
      resourceId: userId,
      oldValue: { tier: before.rows[0].subscription_tier },
      newValue: { tier },
      ipAddress: req.ip
    });

    res.json({ user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/audit-log — paginated audit trail (admin only).
// Supports `userId` + `action` filters and `limit`/`offset` pagination. The
// `total` field is additive (the `{ auditLog }` shape is unchanged) so the
// admin viewer can render page counts without guessing.
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const parsedUserId = Number.parseInt(req.query.userId, 10);
    const userId = Number.isInteger(parsedUserId) && parsedUserId > 0 ? parsedUserId : undefined;
    const action = typeof req.query.action === 'string' && req.query.action.trim()
      ? req.query.action.trim()
      : undefined;

    const clauses = [];
    const filterParams = [];
    if (userId) {
      filterParams.push(userId);
      clauses.push(`user_id = $${filterParams.length}`);
    }
    if (action) {
      filterParams.push(action);
      clauses.push(`action = $${filterParams.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      filterParams
    );
    const rows = await getAuditLogs({ userId, action, limit, offset });

    res.json({
      auditLog: rows,
      total: Number(countResult.rows[0] && countResult.rows[0].total) || 0,
      limit,
      offset
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/feedback-summary — aggregate answer-quality signals only.
// Deliberately excludes prompts, answer text, document names, and free-text
// reasons so the operational dashboard cannot become a content-export API.
router.get('/feedback-summary', async (req, res) => {
  try {
    const parsedDays = Number.parseInt(req.query.days, 10);
    const days = Number.isInteger(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 30;
    const result = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE helpful)::int AS helpful,
         COUNT(*) FILTER (WHERE NOT helpful)::int AS unhelpful,
         MAX(created_at) AS last_submitted_at
       FROM message_feedback
       WHERE created_at >= CURRENT_TIMESTAMP - ($1 * INTERVAL '1 day')`,
      [days]
    );
    const row = result.rows[0] || { total: 0, helpful: 0, unhelpful: 0, last_submitted_at: null };
    const total = Number(row.total) || 0;
    const helpful = Number(row.helpful) || 0;
    return res.json({
      days,
      total,
      helpful,
      unhelpful: Number(row.unhelpful) || 0,
      helpfulRate: total ? helpful / total : null,
      lastSubmittedAt: row.last_submitted_at || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/documents — list every user's documents (admin only)
router.get('/documents', async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const result = await db.query(
      `SELECT d.id, d.user_id, u.email AS user_email, d.filename, d.content_type,
              d.metadata, d.created_at,
              (SELECT COUNT(*) FROM legal_document_chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM legal_documents d
       JOIN users u ON u.id = d.user_id
       ORDER BY d.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ documents: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/documents/:id — delete any user's document (admin only)
router.delete('/documents/:id', async (req, res) => {
  try {
    const documentId = parseDocumentId(req.params.id);
    if (documentId === null) {
      return res.status(400).json({ error: 'Invalid document id' });
    }
    const result = await db.query(
      `DELETE FROM legal_documents WHERE id = $1 RETURNING id, user_id, filename`,
      [documentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await logAudit({
      userId: result.rows[0].user_id,
      action: 'document.deleted_by_admin',
      resourceType: 'document',
      resourceId: documentId,
      newValue: { filename: result.rows[0].filename },
      ipAddress: req.ip
    });
    res.json({ ok: true, deletedId: documentId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
