// Phase 29: Data retention policies.
//
// Enforces configurable retention periods (env vars):
//   RETENTION_CONVERSATIONS_DAYS (default 365)
//   RETENTION_DOCUMENTS_DAYS     (default 365)
//   RETENTION_AUDIT_LOG_DAYS     (default 90)
//
// Hard-deletes rows older than the window. Documents' FK cascades clear
// legal_document_chunks; conversations' FK cascades clear messages.

const db = require('../config/db');

function retentionDays(name, fallback) {
  const raw = Number.parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

const CONVERSATIONS_DAYS = () => retentionDays('RETENTION_CONVERSATIONS_DAYS', 365);
const DOCUMENTS_DAYS = () => retentionDays('RETENTION_DOCUMENTS_DAYS', 365);
const AUDIT_LOG_DAYS = () => retentionDays('RETENTION_AUDIT_LOG_DAYS', 90);

async function cleanupConversations(days = CONVERSATIONS_DAYS()) {
  const result = await db.query(
    `DELETE FROM conversations
     WHERE updated_at < NOW() - ($1::int || ' days')::interval`,
    [days]
  );
  return result.rowCount || 0;
}

async function cleanupDocuments(days = DOCUMENTS_DAYS()) {
  const result = await db.query(
    `DELETE FROM legal_documents
     WHERE created_at < NOW() - ($1::int || ' days')::interval`,
    [days]
  );
  return result.rowCount || 0;
}

async function cleanupAuditLog(days = AUDIT_LOG_DAYS()) {
  const result = await db.query(
    `DELETE FROM audit_log
     WHERE created_at < NOW() - ($1::int || ' days')::interval`,
    [days]
  );
  return result.rowCount || 0;
}

/**
 * Run every cleanup and return a summary. Never throws — each leg is
 * isolated so one failing cleanup doesn't block the others.
 */
async function runRetention() {
  const summary = { conversations: 0, documents: 0, auditLog: 0 };
  const legs = [
    ['conversations', cleanupConversations],
    ['documents', cleanupDocuments],
    ['auditLog', cleanupAuditLog]
  ];
  for (const [key, fn] of legs) {
    try {
      summary[key] = await fn();
    } catch (err) {
      console.error(`[RETENTION] ${key} cleanup failed:`, err.message);
      summary[key] = -1;
    }
  }
  return summary;
}

module.exports = {
  runRetention,
  cleanupConversations,
  cleanupDocuments,
  cleanupAuditLog,
  retentionDays
};
