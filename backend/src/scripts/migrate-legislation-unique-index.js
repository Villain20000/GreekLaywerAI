// Legislation `(source_type, article_number)` unique-index migration.
//
// Problem: `ingestLegislation.js` guarded re-runs with an app-level
// SELECT-then-INSERT check. Two overlapping ingest runs could both pass
// the SELECT and both INSERT, leaving duplicate rows for the same law —
// duplicating pgvector retrieval hits and skewing similarity scores.
//
// This migration:
//   1) De-duplicates legacy rows: keeps the NEWEST row (highest id) per
//      non-null (source_type, article_number) pair and deletes older
//      duplicates. Must run BEFORE the unique-index build or the build
//      fails with "could not create unique index".
//   2) Creates the nullable-safe partial unique index the new ingest
//      upsert targets:
//        `ON CONFLICT (source_type, article_number)
//           WHERE source_type IS NOT NULL AND article_number IS NOT NULL
//         DO NOTHING`
//      (the conflict target repeats the predicate so Postgres can infer
//      this partial index).
//
// Rows with NULL source_type/article_number are unconstrained (legacy
// mocks) and intentionally left untouched, matching the predicate.
//
// Idempotent: the DELETE only removes duplicates; CREATE UNIQUE INDEX
// IF NOT EXISTS is a no-op afterwards. Safe to re-run.
const db = require('../config/db');

async function migrate() {
  console.log('Starting legislation-unique-index migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // 1) Keep the newest row per (source_type, article_number); delete
    //    older dupes. NULL pairs are ignored — the partial unique index
    //    below does not constrain them.
    const deduped = await client.query(
      `DELETE FROM legislation_embeddings a
         USING legislation_embeddings b
        WHERE a.source_type IS NOT NULL
          AND a.article_number IS NOT NULL
          AND a.source_type = b.source_type
          AND a.article_number = b.article_number
          AND a.id < b.id;`
    );
    if (deduped.rowCount) {
      console.log(`  removed ${deduped.rowCount} duplicate legislation row(s)`);
    }

    // 2) Race-free dedupe target for ingestLegislation.js.
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS legislation_embeddings_source_article_uidx
         ON legislation_embeddings(source_type, article_number)
         WHERE source_type IS NOT NULL AND article_number IS NOT NULL;`
    );

    await client.query('COMMIT');
    console.log('legislation-unique-index migration complete.');
    return { ok: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = migrate;
