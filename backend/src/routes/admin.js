const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authMiddleware, rbacMiddleware, ALLOWED_ROLES, ALLOWED_TIERS } = require('../middlewares/authMiddleware');
const { logAudit, getAuditLogs } = require('../services/auditLog');

// All admin endpoints require auth AND admin role.
router.use(authMiddleware);
router.use(rbacMiddleware(['admin']));

function parseUserId(rawId) {
  const parsed = parseInt(rawId, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

// GET /api/admin/users — list every user (without password)
router.get('/users', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, role, subscription_tier, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
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

// GET /api/admin/audit-log — paginated audit trail (admin only)
router.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const rows = await getAuditLogs({
      userId: req.query.userId ? Number.parseInt(req.query.userId, 10) : undefined,
      action: req.query.action || undefined,
      limit,
      offset
    });
    res.json({ auditLog: rows });
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
    const userId = parseUserId(req.params.id);
    if (userId === null) {
      return res.status(400).json({ error: 'Invalid document id' });
    }
    const result = await db.query(
      `DELETE FROM legal_documents WHERE id = $1 RETURNING id, user_id, filename`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await logAudit({
      userId: result.rows[0].user_id,
      action: 'document.deleted_by_admin',
      resourceType: 'document',
      resourceId: userId,
      newValue: { filename: result.rows[0].filename },
      ipAddress: req.ip
    });
    res.json({ ok: true, deletedId: userId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
