#!/usr/bin/env node
// Phase 29: Retention cleanup CLI.
//
// Usage:
//   node src/scripts/retentionCleanup.js
//
// Deletes expired conversations, documents, and audit-log rows per the
// RETENTION_* env vars (see .env.example). Wire this to cron:
//   0 3 * * * cd /opt/nomosai/backend && node src/scripts/retentionCleanup.js

const { runRetention } = require('../services/retention');

(async () => {
  try {
    const summary = await runRetention();
    console.log(
      `[RETENTION] cleanup complete: ` +
      `conversations=${summary.conversations} documents=${summary.documents} ` +
      `audit_log=${summary.auditLog}`
    );
    process.exit(0);
  } catch (err) {
    console.error('[RETENTION] cleanup failed:', err.message);
    process.exit(1);
  }
})();
