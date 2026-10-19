// Vector cosine index migration.
//
// Problem: both HNSW indexes were built with `vector_l2_ops` while every
// similarity query uses the cosine operator (`<=>`; ragService.js,
// documentService.js). Postgres cannot use an L2 index for a cosine ORDER BY,
// so retrieval silently degraded to a sequential scan.
//
// This migration drops both L2 indexes (including the auto-named legacy
// index `legislation_embeddings_embedding_idx` from the unnamed
// CREATE INDEX in the original schema.sql) and recreates them with
// vector_cosine_ops under explicit names. Query results are unchanged —
// cosine was always the query metric; this only makes the indexes usable.
//
// Note: index build can take a while on a large corpus; it is a normal
// (non-CONCURRENTLY) build inside the transaction for atomicity.
const db = require('../config/db');

const STATEMENTS = [
  `DROP INDEX IF EXISTS legal_document_chunks_hnsw_idx;`,
  `DROP INDEX IF EXISTS legislation_embeddings_hnsw_idx;`,
  // Auto-generated name of the unnamed `CREATE INDEX ... USING hnsw
  // (embedding vector_l2_ops)` from the original schema.sql.
  `DROP INDEX IF EXISTS legislation_embeddings_embedding_idx;`,
  `CREATE INDEX IF NOT EXISTS legal_document_chunks_hnsw_idx
     ON legal_document_chunks USING hnsw (embedding vector_cosine_ops);`,
  `CREATE INDEX IF NOT EXISTS legislation_embeddings_hnsw_idx
     ON legislation_embeddings USING hnsw (embedding vector_cosine_ops);`
];

async function migrate() {
  console.log('Starting vector-cosine-indexes migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log('vector-cosine-indexes migration complete.');
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
