// Phase 29 schema parity migration.
//
// Problem: conversations/messages/message_feedback/legal_documents/
// legal_document_chunks/audit_log/subscriptions (and their indexes) were
// only ever defined in database/init/schema.sql, which Postgres runs ONCE on
// a brand-new data volume. Existing deployments following the README's
// pre-Phase-29 migration list never got them — /api/conversations,
// /api/documents, /api/admin/audit-log and GDPR export all 500 with
// "relation does not exist".
//
// This migration is the single bootstrap for every table/index that
// schema.sql defines. It is fully idempotent (IF NOT EXISTS everywhere) and
// FK-safe in the order below. Keep it in lockstep with database/init/schema.sql
// — backend/tests/migrationParity.test.js enforces that every table in the
// schema is created by some migrate-* script.
const db = require('../config/db');

const STATEMENTS = [
  // pgvector extension (no-op when already installed via initdb).
  `CREATE EXTENSION IF NOT EXISTS vector;`,

  // Users (created by the original bootstrap; included so a truly-empty
  // database converges to the same shape).
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email VARCHAR(255) UNIQUE NOT NULL,
     password_hash VARCHAR(255) NOT NULL,
     role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'enterprise')),
     subscription_tier VARCHAR(50) DEFAULT 'basic',
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     token_version INT NOT NULL DEFAULT 1,
     verified_at TIMESTAMPTZ
   );`,

  // Subscriptions + integrity indexes (also enforced by
  // migrate-subscriptions-integrity.js on databases that predate the indexes).
  `CREATE TABLE IF NOT EXISTS subscriptions (
     id SERIAL PRIMARY KEY,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     stripe_customer_id VARCHAR(255),
     stripe_subscription_id VARCHAR(255),
     status VARCHAR(50),
     current_period_end TIMESTAMP,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  // NOTE: the unique index on stripe_subscription_id is created by
  // migrate-subscriptions-integrity.js, which must run AFTER it has
  // de-duplicated any pre-existing rows (a UNIQUE build fails otherwise).
  `CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);`,

  // Conversations + messages.
  `CREATE TABLE IF NOT EXISTS conversations (
     id SERIAL PRIMARY KEY,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     title VARCHAR(255),
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations(user_id);`,
  `CREATE TABLE IF NOT EXISTS messages (
     id SERIAL PRIMARY KEY,
     conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
     content TEXT NOT NULL,
     source_job_id VARCHAR(255),
     citation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_source_job_id_uidx
     ON messages(source_job_id) WHERE source_job_id IS NOT NULL;`,

  // Phase C feedback.
  `CREATE TABLE IF NOT EXISTS message_feedback (
     id SERIAL PRIMARY KEY,
     message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     helpful BOOLEAN NOT NULL,
     reason VARCHAR(500),
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     UNIQUE (message_id, user_id)
   );`,
  `CREATE INDEX IF NOT EXISTS message_feedback_created_at_idx ON message_feedback(created_at);`,
  `CREATE INDEX IF NOT EXISTS message_feedback_helpful_idx ON message_feedback(helpful);`,

  // Legal documents + chunk-level embeddings (vector(1024) = bge-m3).
  `CREATE TABLE IF NOT EXISTS legal_documents (
     id SERIAL PRIMARY KEY,
     user_id INT REFERENCES users(id) ON DELETE CASCADE,
     filename VARCHAR(255) NOT NULL,
     title VARCHAR(255),
     file_url VARCHAR(1024),
     content_type VARCHAR(100),
     parsed_text TEXT,
     metadata JSONB DEFAULT '{}'::jsonb,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS legal_documents_user_id_idx ON legal_documents(user_id);`,
  `CREATE TABLE IF NOT EXISTS legal_document_chunks (
     id SERIAL PRIMARY KEY,
     document_id INT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     embedding vector(1024),
     chunk_index INT NOT NULL DEFAULT 0,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS legal_document_chunks_document_id_idx
     ON legal_document_chunks(document_id);`,
  `CREATE INDEX IF NOT EXISTS legal_document_chunks_hnsw_idx
     ON legal_document_chunks USING hnsw (embedding vector_cosine_ops);`,

  // Audit log.
  `CREATE TABLE IF NOT EXISTS audit_log (
     id SERIAL PRIMARY KEY,
     user_id INT,
     action VARCHAR(100) NOT NULL,
     resource_type VARCHAR(50),
     resource_id VARCHAR(100),
     old_value JSONB,
     new_value JSONB,
     ip_address VARCHAR(64),
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log(user_id);`,
  `CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);`,
  `CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);`,

  // Legislation embeddings (RAG corpus) + cosine HNSW index.
  `CREATE TABLE IF NOT EXISTS legislation_embeddings (
     id SERIAL PRIMARY KEY,
     source_type VARCHAR(100),
     article_number VARCHAR(50),
     title VARCHAR(255),
     content TEXT NOT NULL,
     embedding vector(1024),
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );`,
  `CREATE INDEX IF NOT EXISTS legislation_embeddings_hnsw_idx
     ON legislation_embeddings USING hnsw (embedding vector_cosine_ops);`
];

async function migrate() {
  console.log('Starting Phase-29 schema parity migration...');
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');
    console.log(`Phase-29 schema migration complete (${STATEMENTS.length} statements).`);
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
