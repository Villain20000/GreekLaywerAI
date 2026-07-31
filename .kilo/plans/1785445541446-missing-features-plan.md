# Missing Features Implementation Plan

## Overview

The NomosAI codebase implements through ~Phase 28+ of the README roadmap. The README's "Next likely steps" are partially stale (embeddings and legislation ETL are already implemented) but correctly identify real Stripe integration and benchmark tightening as open items. This plan covers all confirmed missing features across backend, frontend, and infrastructure, organized by priority.

**Key finding:** The README is ~6 phases behind actual code. It states embeddings are mocked and `nomic-embed-text` is the default, but code already uses real `ollama.embeddings()` with `bge-m3` (1024-dim). Similarly, the Greek legislation ETL script (`ingestLegislation.js`) is already implemented.

## Priority Tiers

### Tier 1: Critical (Security, Core Functionality)
Must be completed before production deployment.

### Tier 2: High (Missing CRUD APIs, Data Management, Observability)
Core functionality gaps that prevent the app from being production-ready.

### Tier 3: Medium (Frontend Enhancements, Polish)
UI/UX improvements and developer experience.

### Tier 4: Low (Infrastructure Hardening)
Production hardening, monitoring, and operational maturity.

---

## Tier 1: Critical

### 1. Real Stripe Integration + Webhook Handler

**Status:** `backend/src/routes/billing.js:7` uses `sk_test_mock` and returns a fake URL.

**Files to modify:**
- `backend/src/routes/billing.js` — replace mock with real Stripe Checkout Session creation
- `backend/src/index.js` — add raw body parser for Stripe webhook signature verification
- `backend/src/middlewares/authMiddleware.js:4` — JWT_SECRET should read from env (separate concern, see #5)

**Data flow:**
1. Frontend calls `POST /api/billing/create-checkout-session` with `{ tier }`
2. Backend creates `stripe.checkout.sessions.create()` with line items for the tier
3. Returns `{ url: session.url }` (real Stripe-hosted checkout)
4. Stripe redirects to `success_url` / `cancel_url` after payment
5. Stripe POSTs to `/api/billing/webhook` (raw body, signature-verified)
6. Webhook handler updates `subscriptions` table: `stripe_customer_id`, `stripe_subscription_id`, `status`, `current_period_end`
7. Backend updates `users.subscription_tier` to match paid tier

**Acceptance criteria:**
- `STRIPE_SECRET_KEY` env var required in production (fail fast if missing)
- Checkout session uses real price IDs from Stripe Dashboard config
- Webhook endpoint verifies `Stripe-Signature` header
- `subscriptions` table populated on `checkout.session.completed`
- `users.subscription_tier` updated on `customer.subscription.updated`
- Existing test in `api.test.js:577` updated to expect real session URL shape

**Stripe price IDs:** Configure `STRIPE_PRICE_ID_BASIC`, `STRIPE_PRICE_ID_PRO`, `STRIPE_PRICE_ID_ENTERPRISE` as env vars.

### 2. Inference Queue Wiring

**Status:** `backend/src/services/inferenceQueue.js` is scaffolded (BullMQ Queue + Worker) but never imported in `index.js` or used in `ai.js`.

**Files to modify:**
- `backend/src/index.js` — import and start the worker on boot
- `backend/src/routes/ai.js` — replace direct `ollamaService.generateResponse()` / `ollamaService.streamResponse()` calls with `inferenceQueue.addInferenceJob()`

**Data flow:**
1. User sends `POST /api/ai/query/stream`
2. Route handler calls `ragService.retrieveContext()` (RAG retrieval stays synchronous)
3. Route handler calls `addInferenceJob(prompt, contextStr)` → returns job ID
4. Frontend polls `GET /api/ai/query/stream/:jobId` for status
5. Worker processes job → calls `ollamaService.generateResponse()` → stores result in BullMQ job result
6. Polling endpoint returns `{ status: 'completed', result: response }` or `{ status: 'waiting'|'active' }`

**Acceptance criteria:**
- Worker starts on server boot (idempotent — singleton promise pattern)
- AI routes enqueue jobs instead of calling Ollama directly
- Job status polling endpoint added (`GET /api/ai/query/stream/:jobId`)
- Worker logs processed/failed jobs
- Concurrency remains 1 (GPU protection)
- Health check reports queue status

### 3. Security Hardening

**Status:** `backend/src/index.js:24` has `cors()` with no options. No helmet. No CSRF.

**Files to modify:**
- `backend/src/index.js` — add helmet, configure CORS, add CSRF middleware, add body size limit
- `backend/src/middlewares/` — create `securityHeaders.js`, `csrfProtection.js`

**Specific changes:**
- Add `helmet()` with custom config (CSP, X-Frame-Options, X-Content-Type-Options, etc.)
- Configure `cors()` with `origin` whitelist from `CORS_ORIGINS` env var
- Add `express.json({ limit: '10mb' })` and `express.urlencoded({ limit: '10mb', extended: true })`
- Add CSRF protection for state-changing endpoints (POST/PUT/DELETE) — note: JWT bearer auth reduces CSRF risk, but defense-in-depth is recommended for cookie-based auth paths
- Add security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`

**Acceptance criteria:**
- All security headers present on responses
- CORS restricts to configured origins
- Body parsing limited to 10MB
- CSP header configured for the Angular SPA

### 4. Graceful Shutdown

**Status:** `backend/src/index.js:57` has `app.listen()` with no shutdown handlers.

**Files to modify:**
- `backend/src/index.js` — add SIGTERM/SIGINT handlers

**Implementation:**
- On SIGTERM/SIGINT: stop accepting new requests, drain active connections
- Close DB pool (`db.end()`)
- Close Redis connections (BullMQ queue + worker)
- Close Ollama connection (no persistent connection, but stop warmup promise)
- Exit with code 0 after timeout (30s default)

**Acceptance criteria:**
- Server stops accepting new connections within 1s of signal
- DB pool drains within 30s
- Redis connections close cleanly
- No "address in use" errors on restart

### 5. JWT_SECRET from Environment

**Status:** `backend/src/middlewares/authMiddleware.js:4` hardcodes `JWT_SECRET = process.env.JWT_SECRET || 'nomos-super-secret-key-development'`

**Files to modify:**
- `backend/src/middlewares/authMiddleware.js` — fail fast if `JWT_SECRET` not set in production
- `backend/.env.example` — create with `JWT_SECRET` placeholder

**Acceptance criteria:**
- Production mode (`NODE_ENV=production`) crashes on startup if `JWT_SECRET` is unset or equals the default
- Development mode warns if using default
- `.env.example` documents the variable

### 6. AI Route Rate Limiting

**Status:** `backend/src/middlewares/rateLimiters.js` only limits auth routes. AI routes (`/api/ai/*`) have no rate limiting.

**Files to modify:**
- `backend/src/middlewares/rateLimiters.js` — add AI-specific limiters
- `backend/src/routes/ai.js` — apply AI rate limiters

**Limits:**
- `POST /api/ai/query`: 20/min per user (basic tier), 60/min (pro), 120/min (enterprise)
- `POST /api/ai/query/stream`: 20/min per user (same as above)
- `POST /api/ai/audio-query`: 5/min per user (premium only)
- `POST /api/ai/multimodal`: 10/min per user (premium only)

**Acceptance criteria:**
- Rate limit headers present on AI responses (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`)
- 429 response when limit exceeded
- Tier-based limits enforced via RBAC middleware reading `req.user.subscription_tier`

### 7. Input Validation Middleware

**Status:** No validation middleware exists. Auth routes have inline validation; AI routes have none.

**Files to create:**
- `backend/src/middlewares/validation.js` — reusable validation chains using express-validator (or manual validation)

**Validation rules needed:**
- `POST /api/ai/query`: `prompt` required, string, max 10,000 chars
- `POST /api/ai/audio-query`: file required, audio type check
- `POST /api/billing/create-checkout-session`: `tier` required, must be in ALLOWED_TIERS
- `POST /api/auth/register`: email format, password min 8 chars (already done inline in auth.js)
- `POST /api/auth/change-password`: currentPassword + newPassword required, newPassword min 8 chars (already done inline in auth.js)

**Acceptance criteria:**
- Invalid input returns 400 with descriptive error
- No DB calls made for validation failures
- Validation middleware composable per-route

### 8. Complete Health Check

**Status:** `backend/src/index.js:32` `/health` only returns Ollama warmup status. No DB or Redis connectivity check.

**Files to modify:**
- `backend/src/index.js` — enhance `/health` and `/api/ai/health`

**New health check response:**
```json
{
  "status": "ok" | "degraded" | "unhealthy",
  "service": "NomosAI Backend",
  "timestamp": "2026-...",
  "checks": {
    "database": { "status": "up" | "down", "latency_ms": 5 },
    "redis": { "status": "up" | "down", "latency_ms": 2 },
    "ollama": { "status": "warming" | "ready" | "down", ... },
    "stripe": { "status": "configured" | "missing" }
  }
}
```

**Acceptance criteria:**
- DB connectivity checked via `SELECT 1`
- Redis connectivity checked via `PING`
- Ollama warmup status included
- Stripe configured check
- HTTP 200 if all up, 503 if any down

### 9. CI/CD Pipeline

**Status:** No `.github/workflows` directory exists.

**Files to create:**
- `.github/workflows/ci.yml` — test + lint + build
- `.github/workflows/deploy.yml` — build + push Docker images (on release)

**CI workflow:**
- Trigger on push (main branch) and PR
- Setup Node.js 20
- Install backend deps → run `npm test` (jest)
- Install frontend deps → run `npm test` (karma)
- Build backend Docker image
- Build frontend Docker image
- Upload artifacts

**Acceptance criteria:**
- Tests run on every PR
- Build succeeds
- Failures block merge

---

## Tier 2: High

### 10. Conversations CRUD API

**Status:** `conversations` table exists in `schema.sql:34` but no route file.

**Files to create:**
- `backend/src/routes/conversations.js` — CRUD routes
- `backend/src/middlewares/validation.js` — validation for conversation fields

**Endpoints:**
- `GET /api/conversations` — list user's conversations (paginated)
- `POST /api/conversations` — create new conversation (title optional, auto-generated)
- `GET /api/conversations/:id` — get conversation with messages
- `PUT /api/conversations/:id` — update title
- `DELETE /api/conversations/:id` — delete conversation + messages

**Data flow:**
1. User starts new conversation → `POST /api/conversations` → creates row
2. User sends messages → messages stored in conversation
3. User views history → `GET /api/conversations/:id` → returns conversation + messages
4. User deletes → `DELETE /api/conversations/:id` → cascades delete

**Schema additions needed:**
- `messages` table: `id`, `conversation_id`, `role`, `content`, `created_at`

**Acceptance criteria:**
- All CRUD endpoints return proper HTTP status codes
- User can only access their own conversations
- Pagination on list endpoint
- Messages cascade-deleted with conversation

### 11. Legal Documents CRUD API

**Status:** `legal_documents` table exists in `schema.sql:43` but no route file. `ragService.js` only searches `legislation_embeddings`, not user documents.

**Files to create:**
- `backend/src/routes/documents.js` — CRUD routes for legal documents
- `backend/src/services/documentService.js` — document processing (chunking, embedding, metadata)

**Endpoints:**
- `POST /api/documents` — upload document (multipart: file + optional title)
- `GET /api/documents` — list user's documents
- `GET /api/documents/:id` — get document details
- `GET /api/documents/:id/content` — download/view original file
- `DELETE /api/documents/:id` — delete document
- `POST /api/documents/search` — vector similarity search across user's documents

**Data flow:**
1. User uploads PDF → `POST /api/documents` (multipart)
2. Backend validates file type/size → extracts text (PDF parsing) → chunks text → generates embeddings per chunk → stores document metadata + chunks + embeddings
3. User searches → `POST /api/documents/search` with query → generates query embedding → vector similarity search → returns matching chunks with document context

**Dependencies to add:**
- `pdf-parse` or `pdf-lib` for PDF text extraction
- `mammot` for DOCX text extraction
- `file-type` for file type validation

**Acceptance criteria:**
- File type validation (PDF, DOCX, TXT only)
- File size limit (25MB, matches multer config)
- Text extraction works for PDF/DOCX/TXT
- Embeddings stored in `legal_documents.embedding` column (needs schema migration — add `embedding vector(1024)` column)
- Search returns similarity scores
- User can only access their own documents

### 12. Subscriptions CRUD API

**Status:** `subscriptions` table exists in `schema.sql:23` but no route file.

**Files to create:**
- `backend/src/routes/subscriptions.js` — subscription routes

**Endpoints:**
- `GET /api/subscriptions` — get user's current subscription
- `GET /api/subscriptions/history` — list subscription history
- `POST /api/subscriptions/cancel` — cancel current subscription (at period end)
- `POST /api/subscriptions/upgrade` — upgrade tier (creates new Stripe checkout)

**Acceptance criteria:**
- Returns subscription status from DB
- Cancel defers to period end
- Upgrade triggers new Stripe checkout session

### 13. Subscription Enforcement Middleware

**Status:** AI routes use `rbacMiddleware` for role-based access, but no tier-based enforcement. `users.subscription_tier` is stored but never checked on AI routes.

**Files to create:**
- `backend/src/middlewares/tierMiddleware.js` — checks `req.user.subscription_tier` against route requirements

**Implementation:**
- `requireTier('pro')` or `requireTier('enterprise')` middleware
- Check `req.user.subscription_tier` against required tier
- Return 403 if insufficient tier
- Apply to premium AI routes (`/audio-query`, `/multimodal`)

**Acceptance criteria:**
- Basic users get 403 on premium routes
- Pro users get 403 on enterprise-only routes
- Tier check reads from live DB user (via authMiddleware's `req.user`)

### 14. File Upload Security

**Status:** `backend/src/routes/ai.js:11` multer config has 25MB limit but no file type validation, no filename sanitization, no content type checking.

**Files to modify:**
- `backend/src/routes/ai.js` — add file type validation to multer config
- `backend/src/middlewares/validation.js` — add file validation rules

**Changes:**
- Add `fileFilter` to multer config: only allow `audio/webm`, `audio/wav`, `audio/mp4`, `application/pdf`, `image/png`, `image/jpeg`
- Add filename sanitization (strip path components, generate UUID)
- Add content-type verification (not just extension)
- Add file size limit per endpoint (audio: 10MB, PDF: 25MB, image: 5MB)

**Acceptance criteria:**
- Invalid file types rejected with 400
- Path traversal in filenames prevented
- File size limits enforced per endpoint

### 15. Document Embedding Pipeline

**Status:** `legal_documents` table has no `embedding` column. `ollamaService.generateEmbedding()` exists but is only used for legislation ingestion, not user documents.

**Files to modify:**
- `database/init/schema.sql` — add `embedding vector(1024)` column to `legal_documents`
- `backend/src/services/documentService.js` — generate embeddings on document upload

**Data flow:**
1. Document uploaded → text extracted → text chunked → each chunk embedded via `ollamaService.generateEmbedding()`
2. Embeddings stored in `legal_documents_chunks` table (new) or `legal_documents.embedding` for single-vector documents

**Schema additions:**
- `legal_document_chunks` table: `id`, `document_id`, `content`, `embedding vector(1024)`, `chunk_index`, `created_at`

**Acceptance criteria:**
- Embeddings generated and stored on upload
- Chunk-level embeddings for large documents
- Dimension matches `OLLAMA_EMBED_DIM` env var

### 16. Vector Similarity Search for Legal Documents

**Status:** `ragService.js` only searches `legislation_embeddings`, not user documents.

**Files to modify:**
- `backend/src/services/ragService.js` — add `searchUserDocuments()` method
- `backend/src/routes/documents.js` — add search endpoint

**Implementation:**
- Generate query embedding via `ollamaService.generateEmbedding()`
- Query `legal_document_chunks` via pgvector HNSW index
- Return top-K matching chunks with document metadata and similarity scores

**Acceptance criteria:**
- Search returns ranked results with similarity scores
- Only returns user's own documents
- Results include document title and chunk content

### 17. Document Chunking

**Status:** No chunking logic exists. `legal_documents` table has `parsed_text TEXT` but no chunk-level storage.

**Files to create:**
- `backend/src/services/documentService.js` — `chunkText()` function

**Implementation:**
- Split text into ~500-token chunks with 50-token overlap
- Use sentence boundaries where possible
- Store chunks in `legal_document_chunks` table

**Acceptance criteria:**
- Large documents split into manageable chunks
- Overlap prevents context loss at boundaries
- Chunk indices sequential per document

### 18. Document Metadata Extraction

**Status:** `legal_documents` table has `filename`, `file_url`, `content_type` but no metadata extraction (page count, word count, file size).

**Files to modify:**
- `backend/src/services/documentService.js` — `extractMetadata()` function

**Metadata to extract:**
- File size (from upload)
- Page count (PDF)
- Word count
- Character count
- Creation/modified dates (from PDF/DOCX metadata)

**Acceptance criteria:**
- Metadata stored in `legal_documents.metadata` JSON column
- Metadata extraction doesn't block upload (async or fail gracefully)

### 19. Metrics Endpoint

**Status:** No metrics endpoint. No Prometheus integration.

**Files to create:**
- `backend/src/middlewares/metrics.js` — metrics collection middleware
- `backend/src/index.js` — add `/metrics` endpoint

**Implementation:**
- Use `prom-client` for metrics collection
- Track: request count, request duration, error rate, AI query latency, DB query latency
- Expose `/metrics` endpoint in Prometheus format

**Dependencies to add:**
- `prom-client`

**Acceptance criteria:**
- `/metrics` returns Prometheus-format metrics
- Request count and duration tracked per endpoint
- AI query latency tracked
- DB query latency tracked

### 20. Structured Logging + Request IDs

**Status:** `backend/src/index.js` uses `console.log`/`console.error` only. No request IDs.

**Files to create:**
- `backend/src/middlewares/requestLogger.js` — structured logging middleware

**Files to modify:**
- `backend/src/index.js` — add request ID + logging middleware

**Implementation:**
- Generate UUID v4 request ID per request (`X-Request-ID` header passthrough)
- Log: timestamp, request_id, method, url, status, duration, user_id, error
- Use `pino` or `winston` for structured JSON logging
- Replace all `console.log` with structured logger

**Dependencies to add:**
- `pino` (lightweight JSON logger) or `winston`

**Acceptance criteria:**
- Every request has a unique request ID
- Request ID passed to downstream services (Ollama calls, Stripe calls)
- Logs are JSON-formatted with consistent fields
- Error logs include stack traces

### 21. Audit Logging

**Status:** No audit trail. Admin actions (role changes, tier changes) are not logged.

**Files to create:**
- `backend/src/services/auditLog.js` — audit logging service
- `backend/src/middlewares/audit.js` — audit middleware for admin actions

**Audit events to log:**
- User role changes (admin → user, user → admin)
- Subscription tier changes
- Legal document uploads/deletions
- Account deletions
- Failed login attempts (rate-limited)

**Schema additions:**
- `audit_log` table: `id`, `user_id`, `action`, `resource_type`, `resource_id`, `old_value`, `new_value`, `ip_address`, `created_at`

**Acceptance criteria:**
- All admin actions logged with user ID, timestamp, IP
- Audit log readable via `GET /api/admin/audit-log` (admin only)
- Log retention configurable (default 90 days)

### 22. Data Retention Policies

**Status:** No retention configuration. Old conversations, documents, and audit logs accumulate indefinitely.

**Files to create:**
- `backend/src/services/retention.js` — retention enforcement
- `backend/src/scripts/retentionCleanup.js` — cron script

**Implementation:**
- Configurable retention periods via env vars: `RETENTION_CONVERSATIONS_DAYS`, `RETENTION_DOCUMENTS_DAYS`, `RETENTION_AUDIT_LOG_DAYS`
- Daily cleanup script deletes expired data
- Soft-delete pattern for user-initiated deletions (24h grace period before hard delete)

**Acceptance criteria:**
- Expired conversations deleted after configured days
- Expired documents deleted after configured days
- Audit logs retained per configured policy
- Cleanup script runnable via cron or manual trigger

### 23. Data Export (GDPR)

**Status:** No data export endpoint. Users cannot download their data.

**Files to create:**
- `backend/src/routes/gdpr.js` — GDPR endpoints

**Endpoints:**
- `GET /api/gdpr/export` — export all user data as JSON (conversations, documents, subscriptions, profile)

**Data to include:**
- User profile (email, role, tier, created_at, verified_at)
- All conversations + messages
- All uploaded legal documents (metadata, not file content)
- Subscription history
- Audit log entries for this user

**Acceptance criteria:**
- Export returns JSON with all user data
- Export only includes user's own data
- Export is generated on-demand (not cached)

### 24. Data Deletion (GDPR)

**Status:** No account deletion endpoint.

**Files to modify:**
- `backend/src/routes/gdpr.js` — add deletion endpoint
- `backend/src/routes/auth.js` — add deletion trigger

**Endpoints:**
- `DELETE /api/gdpr/account` — delete user account and all associated data

**Data to delete:**
- User row (cascades to conversations, messages, legal_documents, subscriptions, audit_log)
- Email verification tokens
- Password reset tokens

**Acceptance criteria:**
- Deletion cascades to all user-related tables
- JWT invalidated (token_version bumped)
- Confirmation email sent before deletion (double opt-out)
- Deletion is irreversible

### 25. Fix Frontend Test Mismatches

**Status:** Two test files have expectations that don't match current implementation.

**Files to fix:**
- `frontend/src/app/components/chat/chat.component.spec.ts:30-36` — tests `findAdminLink()` and `findEmailChip()` which query `a.admin-link` and `.user-email` — these elements don't exist in the chat component's inline template (menu component handles these now). Tests should be updated to verify the chat component renders messages correctly, or removed if testing is redundant with menu component tests.
- `frontend/src/app/services/auth.service.spec.ts:60-82` — register test expects `data.token` in response, but Phase 24 flow returns `{ ok: true, requires_verification: true, user }` without a token. Test should be updated to expect `requires_verification: true` and verify no token is stored.

**Acceptance criteria:**
- All frontend tests pass (`npm test`)
- Test expectations match current implementation
- No tests query for elements that don't exist in templates

---

## Tier 3: Medium

### 26. Admin Dashboard for Legal Documents

**Status:** No document management UI. Admin component only manages users.

**Files to create:**
- `frontend/src/app/components/admin-documents/admin-documents.component.ts` — admin document management
- `frontend/src/app/services/document.service.ts` — document API service

**Features:**
- List all users' documents (admin only)
- View document metadata
- Delete documents (admin action)
- Search across all documents

### 27. Subscription Management UI

**Status:** No subscription management page. Billing routes exist but no frontend UI.

**Files to create:**
- `frontend/src/app/components/subscriptions/subscriptions.component.ts`
- `frontend/src/app/services/billing.service.ts` — billing API service

**Features:**
- View current subscription tier
- View subscription status (active, canceled, past_due)
- View current period end
- Change tier (upgrade/downgrade)
- Cancel subscription

### 28. Payment History Page

**Files to create:**
- `frontend/src/app/components/payment-history/payment-history.component.ts`

**Features:**
- List past invoices/payments from Stripe
- View invoice details
- Download PDF receipts

### 29. User Profile Page

**Files to create:**
- `frontend/src/app/components/profile/profile.component.ts`

**Features:**
- View/edit email (with verification)
- Change password
- View subscription tier
- Data export button
- Account deletion button

### 30. Billing/Tier Selection UI

**Files to create:**
- `frontend/src/app/components/billing/billing.component.ts`

**Features:**
- Display available tiers (basic, pro, enterprise)
- Feature comparison table
- Upgrade/downgrade buttons
- Stripe Checkout redirect

### 31. Legal Documents Management UI

**Files to create:**
- `frontend/src/app/components/documents/documents.component.ts`

**Features:**
- Upload new documents (drag & drop)
- List user's documents
- View document details
- Search documents (vector similarity)
- Delete documents

### 32. Conversations History UI

**Files to create:**
- `frontend/src/app/components/conversations/conversations.component.ts`

**Features:**
- List past conversations
- Continue conversation from history
- Delete conversations
- Rename conversations

### 33. Error Boundaries

**Status:** No global error handler in Angular. Only 401s handled in `auth.interceptor.ts:34`.

**Files to create:**
- `frontend/src/app/services/error-handler.service.ts` — global error handler
- `frontend/src/app/components/error-boundary/error-boundary.component.ts` — fallback UI

**Implementation:**
- Implement `ErrorHandler` interface
- Catch `HttpErrorResponse` for 500s, network errors
- Display user-friendly error messages
- Log errors for debugging

### 34. Form Validation

**Status:** Auth components use template-driven forms (`FormsModule`) with minimal validation.

**Files to modify:**
- `frontend/src/app/components/register/register.component.html` — add validation
- `frontend/src/app/components/login/login.component.html` — add validation
- `frontend/src/app/components/change-password/change-password.component.html` — add validation

**Changes:**
- Switch to reactive forms (`ReactiveFormsModule`) with validators
- Add real-time validation feedback
- Disable submit until valid

### 35. Loading States

**Status:** No global loading indicator. Chat component has `isLoading` but no spinner.

**Files to create:**
- `frontend/src/app/components/loading-spinner/loading-spinner.component.ts`
- `frontend/src/app/services/loading.service.ts` — global loading state

### 36. Empty States

**Files to create:**
- `frontend/src/app/components/empty-state/empty-state.component.ts`

**Usage:**
- Conversations list empty
- Documents list empty
- Search results empty

### 37. Accessibility Compliance

**Status:** Minimal a11y attributes. Some `aria-label`, `role`, `aria-hidden` in components.

**Files to modify:**
- `frontend/src/app/styles.scss` — add focus-visible styles
- All component templates — add missing ARIA attributes

**Changes:**
- Ensure all interactive elements have accessible names
- Add `aria-live` for dynamic content
- Ensure keyboard navigation
- Add `prefers-reduced-motion` support
- Color contrast audit

### 38. SEO Optimization

**Status:** No meta tags, no sitemap, no SSR.

**Files to create:**
- `frontend/src/app/services/seo.service.ts` — dynamic meta tags
- `frontend/src/main.ts` — add to index

**Changes:**
- Dynamic title and meta description per route
- Open Graph tags
- Sitemap generation
- Consider Angular Universal for SSR (significant effort)

### 39. PWA Support

**Status:** No manifest, no service worker. `angular.json` has no PWA config.

**Files to create:**
- `frontend/src/manifest.webmanifest`
- `frontend/src/app/app.module.ts` or `app.config.ts` — add ServiceWorkerModule

**Changes:**
- Add `@angular/pwa` dependency
- Configure `ng add @angular/pwa`
- Add manifest with icons, theme color, display mode
- Service worker for offline caching of static assets

### 40. i18n

**Status:** No translation files. UI text is hardcoded in Greek (in chat component) and English (in other components).

**Files to create:**
- `frontend/src/assets/i18n/en.json`
- `frontend/src/assets/i18n/el.json`

**Changes:**
- Add `@ngx-translate/core` dependency
- Create translation service
- Replace hardcoded strings with translation keys
- Add language switcher in menu

### 41. .env.example File

**Status:** `backend/.env` exists but no template for developers.

**Files to create:**
- `backend/.env.example` — template with all env vars documented
- `frontend/.env.example` — template (if needed)

### 42. Redis Persistence Configuration

**Status:** `docker-compose.yml:42` Redis service has no persistence config.

**Files to modify:**
- `docker-compose.yml` — add Redis persistence volume
- `docker-compose.prod.yml` — add Redis persistence volume

**Changes:**
- Add `appendonly yes` and `appendfsync everysec` to Redis config
- Mount Redis data volume

---

## Tier 4: Low

### 43. Backup Strategy

**Files to create:**
- `docker-compose.prod.yml` — add backup service
- `backend/src/scripts/backupDb.js` — backup script

**Changes:**
- Daily PostgreSQL dumps to S3-compatible storage
- Redis RDB snapshots
- Retention policy for backups (7 daily, 4 weekly, 12 monthly)

### 44. Monitoring Stack

**Files to create:**
- `docker-compose.prod.yml` — add Prometheus + Grafana
- `backend/src/middlewares/metrics.js` — Prometheus metrics (see #19)

### 45. Staging Environment

**Files to create:**
- `docker-compose.staging.yml` — staging compose file

### 46. Secrets Management

**Changes:**
- Replace `.env` files with Docker secrets or HashiCorp Vault
- Rotate secrets automatically
- Audit secret access

### 47. Database Backup Automation

**Files to create:**
- `backend/src/scripts/backupDb.js` — automated backup script
- Cron job in docker-compose or Kubernetes CronJob

### 48. SSL/TLS Termination

**Files to modify:**
- `docker-compose.prod.yml` — add nginx reverse proxy with TLS
- `nginx/nginx.conf` — TLS configuration

### 49. Load Balancer

**Files to create:**
- `nginx/nginx.conf` — load balancing config
- `docker-compose.prod.yml` — add nginx service

### 50. Caching Layer

**Changes:**
- Use Redis for API response caching (frequently accessed legislation)
- Cache AI responses for common queries
- CDN for static assets

### 51. CDN

**Changes:**
- Configure CloudFront/Cloudflare for static asset delivery
- Cache invalidation strategy

### 52-66. Security Scanning, APM, Error Tracking, Feature Flags, etc.

- Container security scanning (Trivy, Snyk)
- Security vulnerability scanning (OWASP ZAP, Dependabot)
- Dependency scanning (npm audit, Snyk)
- APM (New Relic, DataDog, Prometheus)
- Error tracking (Sentry)
- Feature flags (LaunchDarkly, Unleash)
- A/B testing framework
- Log aggregation (ELK, Loki)
- Alerting system (AlertManager, PagerDuty)
- Infra-level rate limiting (nginx, Cloudflare)
- WAF (ModSecurity, Cloudflare)
- DDoS protection (Cloudflare, AWS Shield)

---

## Implementation Order

1. **Phase 1 (Critical):** Stripe integration (#1), Inference queue wiring (#2), Security hardening (#3-7), Health check (#8), CI/CD (#9)
2. **Phase 2 (High):** CRUD APIs (#10-12), Subscription enforcement (#13), File upload security (#14), Document pipeline (#15-18), Observability (#19-20), Audit logging (#21), GDPR (#23-24), Test fixes (#25)
3. **Phase 3 (Medium):** Frontend UI components (#26-32), Error boundaries (#33), Form validation (#34), Loading/empty states (#35-36), Accessibility (#37), SEO (#38), PWA (#39), i18n (#40), .env.example (#41), Redis persistence (#42)
4. **Phase 4 (Low):** Backup strategy (#43), Monitoring (#44), Staging (#45), Secrets (#46), DB backup (#47), SSL/TLS (#48), Load balancer (#49), Caching (#50), CDN (#51), Security scanning (#52-54), APM (#55), Error tracking (#56), Feature flags (#57), A/B testing (#58), Log aggregation (#59), Alerting (#60), WAF (#61), DDoS (#62)

## Risks & Considerations

- **Stripe integration:** Requires production Stripe account + price IDs configured. Webhook endpoint must use raw body parser (conflicts with `express.json()`).
- **Inference queue:** Adds Redis dependency for all AI requests. Worker must handle Ollama connection failures gracefully.
- **Document pipeline:** PDF/DOCX parsing adds significant complexity. Consider external service (e.g., Apache Tika) for robust extraction.
- **CSRF:** With JWT bearer auth, CSRF risk is low. Cookie-based auth would need CSRF tokens.
- **PWA:** Adds significant build complexity. Service worker caching strategy must be carefully designed to avoid stale API responses.
- **i18n:** Greek UI text is hardcoded in chat component. Full i18n requires extracting all strings.
- **SSL/TLS:** Requires domain + certificate management. Use Let's Encrypt or cloud provider certs.
- **GDPR:** Data deletion must cascade properly. Soft-delete pattern recommended for recoverability.
- **Test mismatches:** Fixing tests may reveal underlying implementation bugs (e.g., if chat component should show admin link but doesn't).

## Validation Plan

- Backend: `npm test` (jest) must pass after each change
- Frontend: `npm test` (karma) must pass after each change
- Integration: Docker compose must start cleanly with all services
- Stripe: Test with Stripe CLI webhook forwarding
- Document pipeline: Test upload → extract → chunk → embed → search flow
- Health check: Verify all checks report correct status
- Rate limiting: Verify 429 responses at configured thresholds
