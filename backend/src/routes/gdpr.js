// Phase 29: GDPR endpoints.
//
// - GET    /api/gdpr/export   full JSON export of the user's data
// - DELETE /api/gdpr/account  permanent account deletion (requires
//                             { confirm: true, email } — double opt-out)

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { logAudit, deleteAuditLogsForUser } = require('../services/auditLog');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');

// 1-3: per-user caps — export dumps every table; deletion is irreversible.
const limiters = createApiRateLimiters();

// GET /api/gdpr/export — all user data as JSON
router.get('/export', limiters.gdprExport, async (req, res) => {
  try {
    const userId = req.user.id;

    const [profile, conversations, documents, subscriptions, audit, feedback] = await Promise.all([
      db.query(
        `SELECT id, email, role, subscription_tier, created_at, verified_at
         FROM users WHERE id = $1`,
        [userId]
      ),
      db.query(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                (SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'created_at', m.created_at))
                 FROM messages m WHERE m.conversation_id = c.id) AS messages
         FROM conversations c WHERE c.user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT id, filename, content_type, metadata, created_at
         FROM legal_documents WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT id, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at
         FROM subscriptions WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT action, resource_type, resource_id, old_value, new_value, ip_address, created_at
         FROM audit_log WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT message_id, helpful, reason, created_at, updated_at
         FROM message_feedback WHERE user_id = $1`,
        [userId]
      )
    ]);

    res.json({
      exported_at: new Date().toISOString(),
      user: profile.rows[0] || null,
      conversations: conversations.rows,
      documents: documents.rows,
      subscriptions: subscriptions.rows,
      audit_log: audit.rows,
      message_feedback: feedback.rows
    });
  } catch (error) {
    console.error('GDPR export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/gdpr/account — permanent, irreversible deletion.
// Double opt-out: the caller must confirm with the account email.
router.delete(
  '/account',
  limiters.gdprDelete,
  validate([
    check('confirm').isBoolean().withMessage('confirm must be true'),
    check('email').isEmail().withMessage('email is required')
  ]),
  async (req, res) => {
    try {
      if (req.body.confirm !== true) {
        return res.status(400).json({ error: 'You must confirm account deletion' });
      }
      if (req.body.email.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(400).json({ error: 'Email does not match the account email' });
      }

      const userId = req.user.id;

      // FK cascades wipe conversations, messages, legal_documents,
      // subscriptions, tokens. Audit rows are cleared explicitly (they have
      // no FK). A tombstone audit row records the deletion itself.
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);

      await deleteAuditLogsForUser(userId);
      await logAudit({
        userId,
        action: 'account.deleted',
        resourceType: 'user',
        resourceId: userId,
        ipAddress: req.ip
      });

      res.json({ ok: true, message: 'Account permanently deleted' });
    } catch (error) {
      console.error('GDPR account deletion error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
