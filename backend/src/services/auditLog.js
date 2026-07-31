// Phase 29: Audit logging.
//
// Every privileged / security-relevant action (role changes, tier changes,
// document uploads/deletions, account deletions, failed logins) is recorded
// in `audit_log` with user id, action, resource, before/after values, and IP.
// Fail-open: a logging failure never breaks the triggering request.

const db = require('../config/db');

/**
 * Insert one audit event.
 * @param {object} entry { userId, action, resourceType, resourceId, oldValue, newValue, ipAddress }
 */
async function logAudit(entry) {
  try {
    await db.query(
      `INSERT INTO audit_log
         (user_id, action, resource_type, resource_id, old_value, new_value, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.userId ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId != null ? String(entry.resourceId) : null,
        entry.oldValue !== undefined ? JSON.stringify(entry.oldValue) : null,
        entry.newValue !== undefined ? JSON.stringify(entry.newValue) : null,
        entry.ipAddress ?? null
      ]
    );
  } catch (err) {
    console.error('[AUDIT] logAudit failed:', err.message);
  }
}

/**
 * Query the audit log with optional filters + pagination.
 * Admin-only surface (GET /api/admin/audit-log).
 */
async function getAuditLogs({ userId, action, limit = 50, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    clauses.push(`action = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  params.push(offset);
  const result = await db.query(
    `SELECT id, user_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at
     FROM audit_log
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

/**
 * Delete all audit entries owned by a user (GDPR account deletion).
 */
async function deleteAuditLogsForUser(userId) {
  await db.query('DELETE FROM audit_log WHERE user_id = $1', [userId]);
}

module.exports = { logAudit, getAuditLogs, deleteAuditLogsForUser };
