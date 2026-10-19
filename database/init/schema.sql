-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Users Table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'enterprise')),
    subscription_tier VARCHAR(50) DEFAULT 'basic', -- basic, pro, enterprise
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Phase 22: session-invalidation counter. Bumped on password rotation;
    -- authMiddleware rejects JWTs whose `tv` claim is stale relative to this.
    token_version INT NOT NULL DEFAULT 1,
    -- Phase 24: NULL = unverified (no JWT issued until verified_at is set).
    -- `/api/auth/login` rejects unverified accounts with 400 "Email not
    -- verified". `verified_at TIMESTAMPTZ` (rather than BOOLEAN) lets us
    -- audit WHEN verification happened.
    verified_at TIMESTAMPTZ,
    -- Deletion grace period: when set, the account is purged by the
    -- retention job once this timestamp passes. The user can cancel any
    -- time before then (POST /api/gdpr/cancel-deletion).
    deletion_scheduled_for TIMESTAMPTZ
);

-- Subscriptions Table
CREATE TABLE subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    status VARCHAR(50),
    current_period_end TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- One row per Stripe subscription (webhook replays upsert instead of
-- inserting duplicates) + per-user lookup index.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_subscription_id_uidx
    ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions(user_id);

-- Invoices (payment history). Populated by the Stripe webhook handler from
-- invoice.paid / invoice.payment_failed. `stripe_invoice_id` is the idempotency
-- key: webhook replays upsert instead of duplicating rows.
CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    stripe_invoice_id VARCHAR(255) UNIQUE NOT NULL,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    amount_due INT,
    amount_paid INT,
    currency VARCHAR(10),
    status VARCHAR(50),
    hosted_invoice_url TEXT,
    invoice_pdf TEXT,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS invoices_user_id_created_at_idx
    ON invoices(user_id, created_at DESC);

-- Daily usage counters (1-4): one atomic row per user / UTC day / quota kind.
-- `day` is a UTC calendar date; quotaService resets at the next UTC midnight.
-- Mirror of backend/src/scripts/migrate-usage-counters.js.
CREATE TABLE IF NOT EXISTS usage_counters (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, kind)
);

-- Stripe webhook idempotency (1-10): one row per processed event id, claimed
-- BEFORE dispatch (webhook.js). Stripe delivers at-least-once, so a second
-- delivery of the same evt_… id must be acked without reprocessing.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id TEXT PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_processed_at_idx
    ON stripe_webhook_events(processed_at);

-- Conversations Table
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations(user_id);

-- Conversation Messages Table
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    -- Optional idempotency key for assistant responses produced by a queued job.
    source_job_id VARCHAR(255),
    -- Structured Phase B citation/confidence metadata for assistant answers.
    citation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_source_job_id_uidx
    ON messages(source_job_id) WHERE source_job_id IS NOT NULL;

-- Phase C: one replaceable quality signal per user and assistant answer.
CREATE TABLE message_feedback (
    id SERIAL PRIMARY KEY,
    message_id INT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    helpful BOOLEAN NOT NULL,
    reason VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_feedback_created_at_idx ON message_feedback(created_at);
CREATE INDEX IF NOT EXISTS message_feedback_helpful_idx ON message_feedback(helpful);

-- Legal Documents Table (Uploaded Evidence / Contracts)
CREATE TABLE legal_documents (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    title VARCHAR(255),
    file_url VARCHAR(1024),
    content_type VARCHAR(100),
    parsed_text TEXT,
    -- Original uploaded bytes (PDF/DOCX/TXT). Stored in Postgres so a
    -- document row and its file are backed up and deleted atomically.
    original_file BYTEA,
    file_size INTEGER,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS legal_documents_user_id_idx ON legal_documents(user_id);

-- Legal Document Chunks (chunk-level storage + embeddings for user-doc vector search)
CREATE TABLE legal_document_chunks (
    id SERIAL PRIMARY KEY,
    document_id INT NOT NULL REFERENCES legal_documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector(1024),
    chunk_index INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS legal_document_chunks_document_id_idx ON legal_document_chunks(document_id);
CREATE INDEX IF NOT EXISTS legal_document_chunks_hnsw_idx
    ON legal_document_chunks USING hnsw (embedding vector_cosine_ops);

-- Audit Log Table (admin actions, tier changes, account deletions, failed logins)
CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id VARCHAR(100),
    old_value JSONB,
    new_value JSONB,
    ip_address VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);

-- Phase 23: password-reset tokens for /forgot-password + /reset-password.
-- Stores ONLY SHA-256 of the plaintext token (the plaintext is sent via the
-- email link). Single-use via used_at compare-and-set; expires_at = NOW()+1h
-- at issue time.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx
    ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx
    ON password_reset_tokens(user_id);

-- Phase 24: email-verification tokens for /register + /verify-email.
-- Same storage pattern as password_reset_tokens (sha256 of plaintext, single-
-- use via used_at compare-and-set). Separate table — verification and reset
-- serve different purposes and have different TTLs (24h vs 1h).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id          SERIAL PRIMARY KEY,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_token_hash_idx
    ON email_verification_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx
    ON email_verification_tokens(user_id);

-- Phase 31: Embedding model swap from `nomic-embed-text` (768-dim,
-- weak cross-lingual alignment) to `bge-m3` (1024-dim, properly
-- multilingual). Greek-language queries now retrieve Greek-titled
-- legislation correctly. Operators must run `ollama pull bge-m3`
-- and set `OLLAMA_EMBED_MODEL=bge-m3` + `OLLAMA_EMBED_DIM=1024`
-- before applying this schema.
--
-- On a running DB, the one-shot migration sequence is (in order):
--   -- 1) drop the HNSW indexes first, otherwise Postgres refuses
--   --    ALTER COLUMN ... TYPE because the column is index-referenced.
--   --    NOTE: legacy DBs have an auto-named index
--   --    (legislation_embeddings_embedding_idx) from the original unnamed
--   --    CREATE INDEX; migrate-vector-cosine-indexes.js drops both names.
--   DROP INDEX IF EXISTS legislation_embeddings_hnsw_idx;
--   DROP INDEX IF EXISTS legislation_embeddings_embedding_idx;
--   TRUNCATE legislation_embeddings;
--   -- 2) pgvector rejects ALTER if any rows have wrong-dim vectors;
--   --    TRUNCATE above guarantees the column is empty.
--   ALTER TABLE legislation_embeddings
--     ALTER COLUMN embedding TYPE vector(1024);
--   -- 3) recreate the HNSW index against the new dim WITH the cosine
--   --    opclass — queries use `<=>`, so the index must be vector_cosine_ops
--   --    (migrate-vector-cosine-indexes.js does this for live DBs).
--   CREATE INDEX legislation_embeddings_hnsw_idx
--     ON legislation_embeddings USING hnsw (embedding vector_cosine_ops);
--   -- 4) restart the backend with the new env so ollamaService.js
--   --    resolves EMBED_DIM=1024 at module load.
--   docker compose up -d --build backend;
--   -- 5) re-ingest: reads scraped_laws.json + 3 mocks, emits
--   --    1024-dim vectors.
--   docker exec -i greeklaywerai-backend-1 node src/scripts/ingestLegislation.js
--
-- Equivalent shortcut on a brand-new deploy:
--   DROP TABLE IF EXISTS legislation_embeddings CASCADE;
--   \\i database/init/schema.sql    -- this file, fresh
-- then docker compose up -d --build backend + re-ingest.

-- Legislation Schema & Embeddings (for RAG)
CREATE TABLE legislation_embeddings (
    id SERIAL PRIMARY KEY,
    source_type VARCHAR(100), -- e.g., 'Αστικός Κώδικας', 'Ποινικός Κώδικας', 'ΦΕΚ'
    article_number VARCHAR(50),
    title VARCHAR(255),
    content TEXT NOT NULL,
    embedding vector(1024), -- bge-m3 emits 1024-dim vectors (was 768 for nomic-embed-text)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create HNSW index for rapid retrieval. The opclass MUST match the query
-- operator: ragService retrieves with cosine (`<=>`), so the index must use
-- vector_cosine_ops. An L2 index cannot serve a cosine ORDER BY and the
-- planner silently falls back to a sequential scan.
CREATE INDEX IF NOT EXISTS legislation_embeddings_hnsw_idx
    ON legislation_embeddings USING hnsw (embedding vector_cosine_ops);

-- Race-free ingest dedupe: a partial unique index so
-- INSERT ... ON CONFLICT (source_type, article_number) works for non-null
-- pairs. Must match migrate-legislation-unique-index.js (which also dedupes
-- legacy rows before creating it).
CREATE UNIQUE INDEX IF NOT EXISTS legislation_embeddings_source_article_uidx
    ON legislation_embeddings(source_type, article_number)
    WHERE source_type IS NOT NULL AND article_number IS NOT NULL;

-- Partial unique indexes — enforce single-use of an unused token at the DB
-- layer regardless of app-layer compare-and-set correctness. The WHERE
-- filter keeps the unique constraint on (token_hash) only while used_at IS
-- NULL, so once a token row is marked used_at=NOW() the same hash can
-- EXIST alongside it (idempotent re-issue path) but no second *active*
-- row can be inserted by another concurrent request.
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_unused_hash_uidx
    ON password_reset_tokens(token_hash) WHERE used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_verification_tokens_unused_hash_uidx
    ON email_verification_tokens(token_hash) WHERE used_at IS NULL;

-- Email-change verification tokens. `new_email` is the address the user
-- asked to switch to; it only becomes users.email after the token is
-- consumed. Same SHA-256-at-rest + single-use pattern as the other tokens.
CREATE TABLE IF NOT EXISTS email_change_tokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_change_tokens_token_hash_idx
    ON email_change_tokens(token_hash);
CREATE INDEX IF NOT EXISTS email_change_tokens_user_id_idx
    ON email_change_tokens(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS email_change_tokens_unused_hash_uidx
    ON email_change_tokens(token_hash) WHERE used_at IS NULL;
