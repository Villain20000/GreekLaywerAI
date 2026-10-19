#!/usr/bin/env node
// Phase 29 + 1-5: Retention cleanup CLI.
//
// Usage:
//   node src/scripts/retentionCleanup.js
//
// Deletes expired conversations/documents/audit-log rows per the
// RETENTION_* env vars (see .env.example) and logs a per-table count.
// The same summary is written to the audit log by runRetention().
//
// Pruning key per table (see services/retention.js):
//   conversations   → updated_at (activity-based: active chats survive)
//   legal_documents → created_at (age-based)
//   audit_log       → created_at (age-based)
//
// Wire this to cron (the prod compose `retention` sidecar does this):
//   0 3 * * * cd /opt/nomosai/backend && node src/scripts/retentionCleanup.js

const { runRetention } = require('../services/retention');

async function main() {
  const summary = await runRetention();
  console.log(
    `[RETENTION] cleanup complete: ` +
    `conversations=${summary.conversations} documents=${summary.documents} ` +
    `audit_log=${summary.auditLog}`
  );
  return summary;
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('[RETENTION] cleanup failed:', err.message);
      process.exit(1);
    }
  );
}

module.exports = { main };
