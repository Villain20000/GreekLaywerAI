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
    verified_at TIMESTAMPTZ
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

-- Conversations Table
CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Legal Documents Table (Uploaded Evidence / Contracts)
CREATE TABLE legal_documents (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_url VARCHAR(1024),
    content_type VARCHAR(100),
    parsed_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
--   -- 1) drop the HNSW index first, otherwise Postgres refuses
--   --    ALTER COLUMN ... TYPE because the column is index-referenced.
--   DROP INDEX IF EXISTS legislation_embeddings_hnsw_idx;
--   TRUNCATE legislation_embeddings;
--   -- 2) pgvector rejects ALTER if any rows have wrong-dim vectors;
--   --    TRUNCATE above guarantees the column is empty.
--   ALTER TABLE legislation_embeddings
--     ALTER COLUMN embedding TYPE vector(1024);
--   -- 3) recreate the HNSW index against the new dim.
--   CREATE INDEX legislation_embeddings_hnsw_idx
--     ON legislation_embeddings USING hnsw (embedding vector_l2_ops);
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

-- Create HNSW index for rapid retrieval
CREATE INDEX ON legislation_embeddings USING hnsw (embedding vector_l2_ops);

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
