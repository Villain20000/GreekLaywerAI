// Phase 29: GDPR endpoints.
//
// - GET    /api/gdpr/export           full JSON export of the user's data
// - GET    /api/gdpr/deletion-status  scheduled-deletion state for the caller
// - DELETE /api/gdpr/account          schedule account deletion (requires
//                                     { confirm: true, email } — double opt-out)
// - POST   /api/gdpr/cancel-deletion  cancel a scheduled deletion
//
// Deletion is delayed by ACCOUNT_DELETION_GRACE_HOURS (default 24, clamped
// 1..168). The retention sidecar purges accounts whose deadline has passed.

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { validate } = require('../middlewares/validation');
const { check } = require('express-validator');
const { logAudit } = require('../services/auditLog');
const { sendAccountDeletionScheduled } = require('../services/emailService');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');

// 1-3: per-user caps — export dumps every table; account state changes are
// rate-limited more tightly.
const limiters = createApiRateLimiters();

const DEFAULT_GRACE_HOURS = 24;
const MAX_GRACE_HOURS = 168;

/** Resolve the configured grace period, clamped to [1, 168] hours. */
function accountDeletionGraceHours() {
  const raw = process.env.ACCOUNT_DELETION_GRACE_HOURS;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  const parsed = trimmed === '' ? NaN : Number(trimmed);
  const hours = Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_GRACE_HOURS;
  return Math.min(MAX_GRACE_HOURS, Math.max(1, hours));
}

function toIso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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

// GET /api/gdpr/deletion-status — whether a deletion is scheduled.
router.get('/deletion-status', limiters.gdprExport, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT deletion_scheduled_for FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({
      deletionScheduledFor: toIso(result.rows[0]?.deletion_scheduled_for)
    });
  } catch (error) {
    console.error('GDPR deletion status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/gdpr/account — schedule deletion after a grace period.
// Double opt-out: the caller must confirm with the account email. Repeated
// calls are idempotent and never extend the existing deadline.
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
      const graceHours = accountDeletionGraceHours();

      const existing = await db.query(
        `SELECT deletion_scheduled_for FROM users WHERE id = $1`,
        [userId]
      );
      const existingDeadline = toIso(existing.rows[0]?.deletion_scheduled_for);
      if (existingDeadline) {
        return res.json({
          ok: true,
          deletionScheduledFor: existingDeadline,
          graceHours,
          alreadyScheduled: true
        });
      }

      // The WHERE guard makes the write idempotent under a concurrent
      // duplicate request: only the first one sets the deadline.
      const updated = await db.query(
        `UPDATE users
         SET deletion_scheduled_for = CURRENT_TIMESTAMP + ($2::int * INTERVAL '1 hour')
         WHERE id = $1 AND deletion_scheduled_for IS NULL
         RETURNING deletion_scheduled_for`,
        [userId, graceHours]
      );

      let scheduledFor = toIso(updated.rows[0]?.deletion_scheduled_for);
      if (!scheduledFor) {
        const raced = await db.query(
          `SELECT deletion_scheduled_for FROM users WHERE id = $1`,
          [userId]
        );
        scheduledFor = toIso(raced.rows[0]?.deletion_scheduled_for);
        if (!scheduledFor) {
          return res.status(500).json({ error: 'Could not schedule account deletion' });
        }
        return res.json({
          ok: true,
          deletionScheduledFor: scheduledFor,
          graceHours,
          alreadyScheduled: true
        });
      }

      await logAudit({
        userId,
        action: 'account.deletion_scheduled',
        resourceType: 'user',
        resourceId: userId,
        newValue: { deletionScheduledFor: scheduledFor, graceHours },
        ipAddress: req.ip
      });

      // Best-effort notification: email failures are logged, never surfaced.
      try {
        await sendAccountDeletionScheduled(req.user.email, scheduledFor);
      } catch (err) {
        console.error('[GDPR] deletion-scheduled email failed:', err.message);
      }

      res.json({ ok: true, deletionScheduledFor: scheduledFor, graceHours });
    } catch (error) {
      console.error('GDPR account deletion error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// POST /api/gdpr/cancel-deletion — clear a pending deadline. Rows and tokens
// were never removed at scheduling time, so cancellation restores the account.
router.post('/cancel-deletion', limiters.gdprDelete, async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users
       SET deletion_scheduled_for = NULL
       WHERE id = $1 AND deletion_scheduled_for IS NOT NULL
       RETURNING id`,
      [req.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'No account deletion is scheduled' });
    }

    await logAudit({
      userId: req.user.id,
      action: 'account.deletion_cancelled',
      resourceType: 'user',
      resourceId: req.user.id,
      ipAddress: req.ip
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('GDPR deletion cancellation error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
