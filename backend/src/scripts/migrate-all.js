// Migration runner: applies every migrate-*.js script in dependency order.
//
// Usage (inside the backend container):
//   npm run migrate
// or directly:
//   node src/scripts/migrate-all.js
//
// Every script is idempotent (IF NOT EXISTS / guarded ALTERs), so re-running
// the whole chain on an up-to-date database is a safe no-op.
//
// Ordering rationale:
//   - rbac / token-version / token tables: base auth-schema evolution.
//   - phase-29-schema: creates every table that only ever lived in
//     database/init/schema.sql (conversations, messages, documents, chunks,
//     audit_log, …), so later column-level migrations have a target table.
//   - webhook-events: Stripe webhook idempotency table (no FK deps, so it
//     only needs to exist before webhook traffic arrives).
//   - subscriptions-integrity: de-duplicates existing rows BEFORE creating
//     the UNIQUE index (a UNIQUE build on duplicate rows would fail).
//   - usage-counters: daily quota counters (1-4); needs users(id) to exist.
//   - phase-a/b/c: column + index additions on the tables above.
//   - vector-cosine-indexes: swap L2 HNSW indexes for cosine (matches queries).
//   - legislation-unique-index: race-free ingest dedupe (partial unique index
//     on source_type/article_number; de-duplicates legacy rows first).
const migrations = [
  ['rbac — users.role', require('./migrate-rbac')],
  ['token-version — users.token_version', require('./migrate-token-version')],
  ['password-reset-tokens', require('./migrate-password-reset-tokens')],
  ['email-verification', require('./migrate-email-verification')],
  ['phase-29 schema parity', require('./migrate-phase-29-schema')],
  ['webhook events idempotency', require('./migrate-webhook-events')],
  ['subscriptions integrity', require('./migrate-subscriptions-integrity')],
  ['usage counters', require('./migrate-usage-counters')],
  ['phase-a reliability', require('./migrate-phase-a-reliability')],
  ['phase-b citations', require('./migrate-phase-b-citations')],
  ['phase-c feedback', require('./migrate-phase-c-feedback')],
  ['vector cosine indexes', require('./migrate-vector-cosine-indexes')],
  ['legislation unique index', require('./migrate-legislation-unique-index')]
];

async function main() {
  for (const [label, fn] of migrations) {
    console.log(`\n=== Migration: ${label} ===`);
    await fn();
  }
  console.log('\nAll migrations applied.');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration run failed:', err);
      process.exit(1);
    });
}

module.exports = main;
