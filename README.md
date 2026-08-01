# NomosAI — Greek AI Lawyer

> An interactive SaaS virtual lawyer tailored for the Greek Legal System, built on Gemma, augmented with a pgvector-backed RAG layer over Greek legislation, mediated by a role-based access (RBAC) backend, and fronted by a high-end Angular UI.

---

## Table of Contents

1. [Highlights](#highlights)
2. [Architecture](#architecture)
3. [Technology Stack](#technology-stack)
4. [Quick Start](#quick-start)
5. [Environment Variables](#environment-variables)
6. [Database Schema](#database-schema)
7. [Backend API Reference](#backend-api-reference)
8. [Frontend Routes & Components](#frontend-routes--components)
9. [Backend Services & Middlewares](#backend-services--middlewares)
10. [CLI Scripts](#cli-scripts)
11. [Greek Law Scraping Pipeline](#greek-law-scraping-pipeline)
12. [Testing](#testing)
13. [Security & Privacy](#security--privacy)
14. [Production Deployment (GPU)](#production-deployment-gpu)
15. [Project Structure](#project-structure)
16. [Roadmap](#roadmap)

---

## Highlights

- **Local-first inference** — All LLM (Gemma) calls run on the local Ollama runtime; nothing leaves your machine.
- **RAG over Greek legislation** — A pgvector HNSW index enables fast retrieval of relevant Άρθρα (articles) for every question.
- **RBAC baked in** — JWT auth with role (`user`, `admin`, `enterprise`) and tier (`basic`, `pro`, `enterprise`) gating at the route level.
- **Multimodal premium tier** — Admin/enterprise users can ask questions via audio or upload PDFs/images.
- **Cited legal answers (Phase B)** — Structured legislation/document sources and confidence metadata are persisted with conversation messages and shown in an expandable chat panel.
- **Answer feedback (Phase C)** — Users can rate assistant answers, replace their existing vote, while admins get aggregate quality summaries without exposing private prompts or document content.
- **Streaming responses** — Queued inference responses are polled for reliable GPU-safe completion.
- **BullMQ inference queue (Phase 16, currently inactive)** — A concurrency=1 worker scaffold exists for hardware-aware queueing, but the live `ai` routes call the model directly; flip the require on in `src/index.js` to activate.
- **Privacy Shield** — GDPR-friendly middleware that sanitizes logging, blocks caching of legal responses, and tags requests as locally processed.
- **Admin Console** — Promote/demote users and adjust subscription tiers without touching the database.
- **Auth-route rate limiting (Phase 21)** — Per-IP caps on `/api/auth/register`, `/login`, `/change-password`, `/forgot-password`, `/verify-email`, `/resend-verification`; per-account stacked caps on `/change-password` (5/min + 20/day); per-email caps on the recovery endpoints to defeat enumeration. Redis-backed in production, in-memory in tests.
- **Token-version session invalidation (Phase 22)** — Every JWT embeds the user's `token_version`. `authMiddleware` re-reads the live value from Postgres on each authenticated request; if a `/change-password`, password reset, or verification bumps the counter, every older JWT is rejected at the *next* request without a global logout. The check is strict equality (not just `<`) so that impersonation by passing a smaller tv is impossible.
- **Password recovery flow (Phase 23)** — `/forgot-password` issues a SHA-256-hashed token row with 1-hour TTL, mirrored to a single-use partial unique index `(token_hash) WHERE used_at IS NULL`. `/reset-password` consumes the token atomically inside a `BEGIN/SELECT/UPDATE-consume/UPDATE-users/COMMIT` tx, bumps `token_version`, and mints a fresh JWT so the user is auto-signed-in.
- **Email verification at registration (Phase 24)** — `/register` no longer mints a JWT. A new user row is created with `verified_at = NULL`, a `email_verification_tokens` row is inserted, and the user receives `{ ok: true, requires_verification: true, user: { verified_at: null } }`. `/login` rejects unverified accounts with the canonical *"Email not verified. Check your inbox for the verification link."* message. `/verify-email` sets `verified_at = NOW()` and bumps `token_version` atomically, minting the user's first JWT. `/resend-verification` re-issues a fresh token with anti-enumeration jitter.

---

## Architecture

```
┌──────────────────┐      ┌──────────────────────────────────┐
│  Angular 17 SPA  │─────▶│  Express.js Backend (port 3000)  │
│  (port 4200)     │      │  Routes: auth, ai, admin, billing│
│  GSAP / Three.js │      │  ├─ privacyShield (global)       │
│                  │      │  ├─ authMiddleware + rbac        │
└──────────────────┘      │  ├─ RAG Service  →  PostgreSQL    │
                         │  ├─ Ollama Service → Ollama      │
                         │  └─ BullMQ Worker  → Redis       │
                         └──────────────────────────────────┘
                                       │
              ┌────────────────────────┼───────────────────────┐
              ▼                        ▼                       ▼
       ┌─────────────┐        ┌──────────────────┐      ┌─────────────┐
       │ PostgreSQL  │        │  Ollama + Gemma  │      │   Redis 7   │
       │  pgvector   │        │   (port 11434)   │      │  (BullMQ)   │
       │ (port 5432) │        │  Local GPU ready │      │ (port 6379) │
       └─────────────┘        └──────────────────┘      └─────────────┘
```

---

## Technology Stack

| Layer        | Tech                                                                          |
|--------------|-------------------------------------------------------------------------------|
| Frontend     | Angular 17 (standalone components) · RxJS · GSAP · Three.js                  |
| Backend      | Node.js 20 · Express.js · JWT (`jsonwebtoken`) · bcryptjs · multer             |
| Database     | PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) (HNSW index)    |
| AI Runtime   | [Ollama](https://ollama.com) running `gemma:2b` (Gemma family)                |
| Queue        | [BullMQ](https://docs.bullmq.io) on Redis 7 (concurrency=1 for GPU safety)    |
| Billing      | Stripe SDK (mocked in dev)                                                    |
| Infra        | Docker Compose (dev + prod), NVIDIA Container Toolkit in prod                 |
| Scraping     | Python 3.10+ (BeautifulSoup4 / Playwright prototype)                          |

---

## Quick Start

### Prerequisites

- Docker 24+ and Docker Compose v2
- *(Optional)* NVIDIA GPU + NVIDIA Container Toolkit for accelerated inference
- Free ports: `4200` (frontend), `3000` (backend), `5432` (db), `6379` (redis), `11434` (ollama)

### One-command dev stack

```bash
docker-compose up --build
```

What comes up:

| Container          | Image                       | Port |
|--------------------|-----------------------------|------|
| `frontend`         | built from `./frontend`     | 4200 |
| `backend`          | built from `./backend`      | 3000 |
| `db`               | `ankane/pgvector:v0.5.1`    | 5432 |
| `redis`            | `redis:7-alpine`            | 6379 |
| `ollama`           | `ollama/ollama`             | 11434 |

### Bootstrap the first admin user

The backend auto-creates the schema on first boot. Wait ~10 seconds, then:

```bash
docker exec -it greeklaywerai-backend-1 \
  node src/scripts/create-admin.js admin@nomos.ai 'ChangeMe123!'
```

Log in at `http://localhost:4200/login`.

> **Phase 24 gotcha**: `create-admin.js` inserts the admin row with `verified_at = NULL` (same as the UI registration flow). `/login` rejects the admin with *“Email not verified. Check your inbox for the verification link.”* Two dev-friendly workarounds, in order of preference:
> 1. Read the `[DEV-EMAIL] Email-verification requested for …` line from `docker logs greeklaywerai-backend-1`, copy the `Verify URL`, and paste it into the browser. That hits `/verify-email?token=…`, swaps in the admin's first JWT, and routes to `/chat`.
> 2. Mark verified directly in Postgres: `docker exec -it greeklaywerai-db-1 psql -U nomos_admin -d nomos_db -c "UPDATE users SET verified_at = NOW() WHERE email='admin@nomos.ai';"`
>
> Real SMTP integration would replace the dev console transport and let the verification email land in the operator's inbox normally.

### Seed legislation embeddings (optional)

```bash
docker exec -it greeklaywerai-backend-1 node src/scripts/ingestLegislation.js
```

This inserts a small mock corpus (Civil Code articles 57 & 288, Penal Code article 299) so RAG retrieval has something to find on day one.

### Apply post-v0.1 migrations on existing deployments

Each migration below is *idempotent* (uses `ADD / CREATE ... IF NOT EXISTS`) so it is safe to run on a database that already has the columns or tables — but you DO need to run them once on a fresh dev DB to bring it forward to current parity with `database/init/schema.sql` (the init script only fires on a brand-new Postgres container).

```bash
# Phase 22 — users.token_version (JWT session invalidation counter)
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-token-version.js

# Phase 23 — password_reset_tokens table (forgot/reset flow)
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-password-reset-tokens.js

# Phase 24 — users.verified_at + email_verification_tokens table
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-email-verification.js

# Phase A reliability — document titles + queued-message idempotency
# Run once on existing databases; safe to re-run.
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-phase-a-reliability.js

# Phase B — persisted citation metadata for cited answers
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-phase-b-citations.js

# Phase C — answer feedback quality loop
# MUST succeed before deploying/restarting the backend that joins message_feedback.
docker exec -it greeklaywerai-backend-1 node src/scripts/migrate-phase-c-feedback.js
```

---

## Environment Variables

### Backend (`backend` service in `docker-compose.yml`)

| Variable          | Default                       | Purpose                                  |
|-------------------|-------------------------------|------------------------------------------|
| `PORT`            | `3000`                        | Express port                             |
| `DB_HOST`         | `db`                          | Postgres host (use `localhost` outside Docker) |
| `DB_PORT`         | `5432`                        | Postgres port                            |
| `DB_USER`         | `nomos_admin`                 | Postgres user                            |
| `DB_PASSWORD`     | `nomos_password`              | Postgres password                        |
| `DB_NAME`         | `nomos_db`                    | Postgres database                        |
| `OLLAMA_URL`      | `http://ollama:11434`         | Ollama base URL                          |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text`         | Ollama embedding model used by RAG (Phase 26). Pull it once via `docker exec greeklaywerai-ollama-1 ollama pull nomic-embed-text` — `/api/ai/query` will surface a `Could not reach Ollama` 500 until the model is present. |
| `OLLAMA_EMBED_DIM` | `768`                        | Vector dimension of `OLLAMA_EMBED_MODEL`. Must match the dim returned by the model AND the `legislation_embeddings.embedding vector(…)` column type. Garbage values (non-numeric, zero, negative) fall back to 768 with no error so misconfig is loud (not silent). |
| `REDIS_URL`       | `redis://redis:6379`          | Redis for BullMQ                         |
| `STRIPE_SECRET_KEY` | `sk_test_mock`              | Stripe key (mock returns success)        |
| `JWT_SECRET`      | `nomos-super-secret-key-development` | Override in prod                 |
| `NODE_ENV`        | *(unset)*                     | Set to `production` for prod compose     |
| `ADMIN_MAGIC_LINK_ENABLED` | *(unset)*              | Set to `true` to enable `POST /api/auth/admin-magic-link/redeem` in production. Off-by-default; dev compose leaves `NODE_ENV` unset so the route is enabled automatically. |

### Frontend

The frontend reads nothing from env at runtime — the API URL is hard-coded as `http://localhost:3000` inside `src/app/services/*.service.ts`. Change those if you deploy behind a different host.

---

## Database Schema

Initialized automatically by `database/init/schema.sql` on first DB boot. Eight tables + the `vector` extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

| Table                       | Phase | Purpose                                                    |
|-----------------------------|-------|------------------------------------------------------------|
| `users`                     | —     | Accounts; columns: `id`, `email`, `password_hash`, `role`, `subscription_tier`, `token_version` (Phase 22, session-invalidation counter), `verified_at` (Phase 24, NULL until `/verify-email` succeeds) |
| `subscriptions`             | —     | Stripe customer/subscription linkage                       |
| `conversations`             | —     | Chat history (linked to `users.id`)                        |
| `legal_documents`           | —     | User-uploaded evidence/contracts (PDFs, images)            |
| `legislation_embeddings`    | —     | Greek legislation chunks with 768-dim vectors for RAG      |
| `password_reset_tokens`     | 23    | One-time `/forgot-password` tokens (1-hour TTL)            |
| `email_verification_tokens` | 24    | One-time `/register` + `/resend-verification` tokens (24h TTL) |

Indices:

- `HNSW` over `legislation_embeddings.embedding` (L2 distance) — sub-linear RAG retrieval.
- B-tree on `password_reset_tokens.token_hash` and `email_verification_tokens.token_hash` — fast lookup on the `/reset-password` and `/verify-email` SELECT.
- **Partial unique** `(token_hash) WHERE used_at IS NULL` on both token tables — DB-level single-use enforcement. Two concurrent `/reset-password` (or `/verify-email`) requests for the same token cannot both succeed even if the app-layer compare-and-set were ever bypassed.

Migrations (run idempotently on existing databases):

- `migrate-rbac.js` — adds `users.role` and backfills from `subscription_tier` (pre-Phase 17).
- `migrate-token-version.js` — adds `users.token_version INT NOT NULL DEFAULT 1` (Phase 22).
- `migrate-password-reset-tokens.js` — creates `password_reset_tokens` + indexes + partial-unique (Phase 23).
- `migrate-email-verification.js` — adds `users.verified_at`, creates `email_verification_tokens` + indexes + partial-unique (Phase 24).

---

## Backend API Reference

Base URL: `http://localhost:3000`

### `GET /health`
Liveness probe. Returns `{ status: "ok", service: "NomosAI Backend", localPrivacyEnabled: true }`.

### `/api/auth` — Public

| Method | Path                   | Body                          | Response                                                            |
|--------|------------------------|-------------------------------|---------------------------------------------------------------------|
| POST   | `/register`            | `{ email, password, role? }`  | **{ ok: true, requires_verification: true, user }** (no `token`)    |
| POST   | `/login`               | `{ email, password }`         | `{ token, user }` OR 400 *“Email not verified…”* if `verified_at IS NULL` |
| POST   | `/forgot-password`     | `{ email }`                   | Always 200 `{ ok: true }` (anti-enumeration)                        |
| POST   | `/reset-password`      | `{ token, newPassword }`      | 200 `{ ok, token, user }` on valid token, 400 *“Invalid or expired reset link”* otherwise. Bumps `token_version`. |
| POST   | `/verify-email`        | `{ token }`                   | 200 `{ ok, token, user }` on valid token, 400 *“Invalid or expired verification link”* otherwise. Sets `verified_at = NOW()` and bumps `token_version`. |
| POST   | `/resend-verification` | `{ email }`                   | Always 200 `{ ok: true }` (anti-enumeration; only re-issues a token if user exists AND is unverified) |
| POST   | `/change-password`     | `{ currentPassword, newPassword }` | 200 `{ ok, token, user }` with freshly-bumped-token-version JWT (Phase 22); old JWTs become invalid on the next request |
| GET    | `/me`                  | —                             | 200 `{ user: { id, email, role, subscription_tier, created_at, token_version } }` |

Notes:

- **Client-supplied `role` is always coerced to `user`.** Any attempt to self-register as `admin` returns **403** even on a malformed body.
- **Token TTL is 24h.** The `role` claim is normalized through `subscription_tier` for legacy-token compatibility.
- **`MIN_PASSWORD_LENGTH = 8`** is the single source of truth — server, client (RegisterComponent / ChangePasswordComponent / ResetPasswordComponent all import it from `frontend/src/app/shared/auth.constants.ts`).
- **Phase 22**: every authenticated request triggers a fresh SELECT in `authMiddleware` for `id / email / role / subscription_tier / created_at / token_version`. The JWT's `tv` claim is compared strict-equality to the live DB value. A mismatch (because `/change-password` or `/reset-password` bumped the counter) returns **401 *“Session invalidated; please log in again.”*** — never a silent acceptance of a stale token.
- **Phase 23 / Phase 24 token storage**: tokens (reset, verification) are stored as **SHA-256 of the plaintext** — the plaintext is sent only via email. `expires_at` enforced at the SQL `WHERE` clause; `used_at IS NULL` enforces single-use. A DB leak therefore yields hashed values that cannot be replayed.
- **Phase 23 reset path** does a `BEGIN / SELECT / UPDATE used_at (compare-and-set) / UPDATE users (password_hash + token_version + 1) / COMMIT` so a crash between the two UPDATEs rolls back atomically — there is no state where the token is “consumed” without the password having been rotated.
- **Phase 24 verify path** is the same pattern with `verified_at = NOW()` instead of `password_hash`.
- **Phase 21 rate limits**: `register` 5/hr per IP (test ceiling 1000), `login` 10/min per IP, `changePasswordPreAuth` 30/min per IP + `changePasswordPerAccount` 5/min + 20/day per user-id, `forgotPasswordIpMin` 5/min + `forgotPasswordIpHour` 20/hr + `forgotPasswordEmail` 3/hr per email, `resetPasswordIp` 10/min per IP, `verifyEmailIp` 20/min per IP, `resendVerificationIp` 5/min per IP + `resendVerificationEmail` 3/hr per email. Redis-backed in production (`rate-limit-redis` + `ioredis`); in-memory in tests. `passOnStoreError: true` so a Redis blip fails OPEN rather than 500-ing.

### `/api/ai` — Auth required (gated per route)

| Method | Path             | Body / Form                        | Allowed roles               |
|--------|------------------|------------------------------------|-----------------------------|
| POST   | `/query`         | `{ prompt, useRag?, conversationId?, documentIds? }` | `user`, `admin`, `enterprise` |
| POST   | `/query/stream`  | `{ prompt, useRag?, conversationId?, documentIds? }` | `user`, `admin`, `enterprise` |
| POST   | `/audio-query`   | `multipart audio` (max 25 MB)      | `admin`, `enterprise`         |
| POST   | `/multimodal`    | `multipart file` (max 25 MB)       | `admin`, `enterprise`         |

### `/api/billing` — Auth required

| Method | Path                       | Allowed roles                 |
|--------|----------------------------|-------------------------------|
| POST   | `/create-checkout-session` | `user`, `admin`, `enterprise` |

Body: `{ tier: "basic" | "pro" | "enterprise" }`. Currently mocks a Stripe redirect to `http://localhost:4200/chat?mock_payment=success&tier=...`.

### `/api/admin` — Auth + Admin role required

| Method | Path                          | Body                         |
|--------|-------------------------------|------------------------------|
| GET    | `/users`                      | —                            |
| PATCH  | `/users/:id/role`             | `{ role: "user"\|"admin"\|"enterprise" }` |
| PATCH  | `/users/:id/tier`             | `{ tier: "basic"\|"pro"\|"enterprise" }` |

The `PATCH role` endpoint refuses to demote yourself (returns 409) so the system never gets locked out of admins.

`GET /feedback-summary?days=30` returns only aggregate helpful/unhelpful counts and rate; it never returns prompts, answers, document names, or free-text feedback reasons.

---

## Frontend Routes & Components

| Path                | Component                  | Guard                       | Purpose                                                |
|---------------------|----------------------------|-----------------------------|--------------------------------------------------------|
| `/`                 | `LandingComponent`         | —                           | Three.js + GSAP hero splash                            |
| `/login`            | `LoginComponent`           | —                           | Email/password login (Phase 24: surfaces inline Resend-verification affordance on `kind: 'unverified'`) |
| `/register`         | `RegisterComponent`        | —                           | Sign-up form (Phase 24: shows “Check your email” panel on success instead of routing to `/chat`) |
| `/forgot-password`  | `ForgotPasswordComponent`  | —                           | Email-only form → always 200                           |
| `/reset-password`   | `ResetPasswordComponent`   | —                           | Reads `?token=…` from queryParamMap → resets + auto-signs-in |
| `/verify-email`     | `VerifyEmailComponent`     | —                           | Reads `?token=…` from queryParamMap → verifies + auto-signs-in (Phase 24) |
| `/change-password`  | `ChangePasswordComponent`  | `authGuard`                 | Authenticated password rotation (Phase 22: server returns fresh token in response) |
| `/chat`             | `ChatComponent`            | `authGuard`                 | SSE streaming chat + 🎤 voice input                   |
| `/admin`            | `AdminComponent`           | `adminGuard` (admin only)   | User & subscription management                         |
| `**`                | redirects to `/`           |                             |                                                        |

### Frontend services

- **`AuthService`** — wraps `/api/auth/*` (Phase 24: `register()` now returns a discriminated `RegisterResult` with `requires_verification`; `login()` returns a discriminated result with `kind: 'invalid_credentials' | 'unverified' | 'network' | 'server'`; new `verifyEmail(token)` and `resendVerification(email)` wrappers). Token + user swap on successful password change / reset / verification is implemented identically so guards pick up the rotated credential instantly. RxJS `token$` and `user$` BehaviorSubjects; hydrates from `localStorage` on cold start.
- **`AiService`** — `streamQuery(prompt, conversationId, documentIds)` polls queued inference and emits `{ content, messageId, sources, confidence }`; `uploadAudio(blob)` uses the same contract. `submitFeedback(messageId, helpful, reason?)` replaces the signed-in user's existing vote for that answer.
- **`AdminService`** — `listUsers`, `updateRole`, `updateTier` (auto-logs-out on 401).

### Frontend guards & interceptors

- **`authGuard`** — Redirects to `/login` if no JWT.
- **`adminGuard`** — Redirects non-admins to `/chat`.
- **`authInterceptor`** — Attaches `Authorization: Bearer <token>` to all outbound HTTP. **Phase 22**: a global `catchError` calls `AuthService.logout()` on any **401** so other tabs/devices holding the now-stale token after `/change-password` silently fall back to `/login` without showing API errors in the UI.

### Frontend constants

- **`shared/auth.constants.ts`** — single source for `MIN_PASSWORD_LENGTH = 8` (and any future auth-shaped thresholds). Imported by `RegisterComponent`, `ChangePasswordComponent`, `ResetPasswordComponent`, and `VerifyEmailComponent` so the UI floor matches the server's enforced floor byte-for-byte.

---

## Backend Services & Middlewares

### `services/emailService.js` (Phase 23 + 24)

Pluggable email transport for the password-recovery and email-verification flows. Currently a *dev* `console` provider that logs the reset / verify URL with a `[DEV-EMAIL]` prefix to stdout — copy it out of `docker logs` to walk through the flow locally. A shared `assertSafeSend()` helper **hard-throws** if `NODE_ENV === 'production'` (the dev transport prints the raw bearer credential) and fails loud if `EMAIL_TRANSPORT` is set to anything other than `console`. Production swap-in is one file change: a nodemailer (or RESEND / Postmark / SendGrid) provider gated on `process.env.EMAIL_TRANSPORT === 'smtp'` + `SMTP_HOST/PORT/USER/PASS/EMAIL_FROM`. Exposed surface (unchanged across transports):

- `sendPasswordReset(toEmail, resetToken)` — `/forgot-password` calls this with the plaintext SHA-256-not-yet'd token.
- `sendEmailVerification(toEmail, verifyToken)` — `/register` and `/resend-verification` fire this with the plaintext verify token.

### `middlewares/rateLimiters.js` (Phase 21)

`createRateLimiters()` factory that hands back a map of `express-rate-limit@7` middlewares keyed by route (`register`, `login`, `changePasswordPreAuth`, `changePasswordPerAccount`, `changePasswordPerAccountDaily`, `forgotPasswordIpMin`, `forgotPasswordIpHour`, `forgotPasswordEmail`, `resetPasswordIp`, `verifyEmailIp`, `resendVerificationIp`, `resendVerificationEmail`). Honors `NODE_ENV === 'test'` automatically — applies a 1000-iteration `TEST_CEILING` to every limit so a single jest suite can run dozens of requests from `127.0.0.1` without tripping. `passOnStoreError: true` so a Redis outage fails open. Per-IP keys use `req.ip` (configured via `trust proxy` in `index.js` — `'uniquelocal,loopback'` by default); per-account keys split on `req.user.id` (populated by `authMiddleware`); per-email keys lowercase + trim the address before keying so case-variants share a bucket. Comprehensive section listing per-key caps in [Backend API Reference → /api/auth](#apiauth--public).

### `services/ollamaService.js`
Pure wrapper around the Ollama JS SDK. Exports:

- `generateResponse(prompt, contextStr)` — non-streaming chat.
- `streamResponse(prompt, contextStr, res)` — SSE writer; sends `data: [DONE]` terminator.
- `generateEmbedding(text)` — currently returns a mock 768-dim random vector (placeholder for an Ollama embedding model or Gemini Embeddings API).

A canonical system prompt forces the model to act as an elite Greek attorney that answers in formal Greek and refuses to hallucinate articles.

### `services/ragService.js`
- `retrieveContext(query, limit=3)` — embeds the query, then runs a pgvector similarity search against `legislation_embeddings` ordered by L2 distance.
- `formatContextForGemma(docs)` — formats hits as `Πηγή — Άρθρο — Τίτλος — Content`.

### `services/inferenceQueue.js` (Phase 16)
BullMQ-backed queue with concurrency=1 intended to gate GPU access (so a single local GPU isn't overwhelmed by massive 128K-context RAG queries). **Currently not wired in** — `index.js` and `routes/ai.js` call `ollamaService` directly and never `require` this module, so the worker never starts. To activate it: add `require('./services/inferenceQueue')` once during bootstrap (side-effect import) and swap the synchronous call sites in `routes/ai.js` for `inferenceQueue.addInferenceJob(...)`.

### `middlewares/privacyShield.js`
Mounted globally. Per request it:
1. Logs *only* the URL + method (no body).
2. Sets `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate` and Pragma/Expires headers to prevent intermediate caches from retaining legal answers.
3. Stamps `req.isLocallyProcessed = true` (the `/health` endpoint surfaces this).

### `middlewares/authMiddleware.js`
- `authMiddleware` — parses `Authorization: Bearer <token>`, verifies with the shared JWT secret, attaches a normalized `req.user`.
- `rbacMiddleware([allowed])` — factory returning a guard that 403s if the user's role isn't in the allowed list.
- `normalizeRole(role, tier)` — legacy token compatibility: enterprise tier → enterprise role, admin tier → admin role, otherwise user.

---

## CLI Scripts

All scripts live in `backend/src/scripts/`.

### `create-admin.js`

```bash
node src/scripts/create-admin.js <email> <password>
```

Creates the user if absent, otherwise promotes them to `role=admin, subscription_tier=enterprise`. **Phase 24 note**: the inserted row leaves `verified_at = NULL`; the bootstrap operator needs to either hit the `[DEV-EMAIL] Email-verification requested for …` URL in `docker logs` or `UPDATE users SET verified_at = NOW()` directly. A future change could mark verified at creation (recommended for the dev `create-admin` shortcut since the CLI is run with operator-console access, not via the customer email flow).

### `create-admin-magic-link.js` (Phase 25)

```bash
node src/scripts/create-admin-magic-link.js <email> [ttlMinutes]
```

Mints a short-lived (default 5 min, max 60) signed JWT and prints a
`http://localhost:4200/admin-login?token=<jwt>` URL. Paste the URL into a
browser to land signed in at `/admin` without typing a password.

**Security model:**

- Token is signed with the same `JWT_SECRET` the backend uses to mint
  session JWTs. A separate `kind: 'admin_magic'` claim makes it safe to
  use `jwt.verify` here without trading away session-token isolation.
- TTL is bounded by `expiresIn`. `jwt.verify` throws on expiry; the route
  returns 400.
- The redeem endpoint re-reads `users.role` from the LIVE row (Phase 22
  posture), so demoting an admin between mint and redeem blocks the
  redemption. Legacy `tier='admin'` rows are accepted here for parity
  with `authMiddleware`'s `normalizeRole()` rule.
- On success the redeem bumps `users.token_version`, invalidating any
  other live session JWTs for that admin; the freshly-signed session
  JWT below carries the new `tv` and `authMiddleware` accepts it.
- **Hard gate**: with `NODE_ENV=production`, both the CLI and the route
  refuse to run unless `ADMIN_MAGIC_LINK_ENABLED=true` is set. The dev
  compose leaves `NODE_ENV` unset → enabled automatically.
- **Within the TTL window, the same bearer can be redeemed more than
  once.** Each replay mints a new session JWT and bumps `tv` again — no
  DB-backed jti dedupe. This is a deliberate trade-off for a dev shortcut;
  shorten the TTL or add dedupe if operating in a higher-trust regime.
- The URL is a bearer credential. Anyone who reads the URL before the
  TTL elapses can log in — treat it like a password. Forwarding via
  email / Slack leaks it. Browser history and the `Referer` header also
  leak it. Use TLS in any non-localhost deployment.

### `migrate-rbac.js`

```bash
node src/scripts/migrate-rbac.js
```

Idempotent migration: adds `users.role` (NOT NULL, CHECK constraint) and backfills from `subscription_tier`. Safe to re-run.

### `migrate-token-version.js` (Phase 22)

```bash
node src/scripts/migrate-token-version.js
```

`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1`. Existing rows backfill atomically to 1. Safe to re-run.

### `migrate-password-reset-tokens.js` (Phase 23)

```bash
node src/scripts/migrate-password-reset-tokens.js
```

`CREATE TABLE IF NOT EXISTS password_reset_tokens (...)` + indexes + the partial unique `(token_hash) WHERE used_at IS NULL`. Safe to re-run.

### `migrate-email-verification.js` (Phase 24)

```bash
node src/scripts/migrate-email-verification.js
```

`ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ` + `CREATE TABLE IF NOT EXISTS email_verification_tokens (...)` + indexes + partial unique. Safe to re-run.

### `ingestLegislation.js` (Phase 26: scrape → RAG wiring)

```bash
node src/scripts/ingestLegislation.js
```

Bridges the Python scraper (`prototype_scraper.py`) into the live RAG layer so the LLM has real Greek-law context for every user question:

1. **Reads** `<repo-root>/scraped_laws.json` if present (override via the `SCRAPED_LAWS_PATH` env var). Schema mapping: scraper `source/law_number/law_title/full_text → source_type/article_number/title/content`.
2. **Drops** scraped rows with missing critical fields (`full_text` empty or `law_number` blank).
3. **Merges** the scraped corpus with 3 hardcoded fallback mock articles (Civil Code Άρθρα 57 & 288; Penal Code Άρθρο 299) so a brand-new env — even before the Python scraper has run — still has something for RAG to surface.
4. **Embeds** each row via the live Ollama embed model (`nomic-embed-text` by default, configurable via `OLLAMA_EMBED_MODEL`). Failures here surface as `[ingest] Failed to ingest <condition>` per row, AND a non-zero process exit code.
5. **Idempotent re-runs**: a SELECT-then-INSERT guard on `(source_type, article_number)` skips already-ingested rows. Safe to rerun after every scrape refresh.

**Operator setup (one-time):**

```bash
docker exec greeklaywerai-ollama-1 ollama pull nomic-embed-text
```

Without that pull, the script (and `/api/ai/query`) will fail loudly with a clear error rather than silently returning noise vectors (the pre-Phase-26 bug class).

**Pipelining workflow after each scrape refresh:**

```bash
# (a) Refresh scraped_laws.json at the repo root
python3 prototype_scraper.py

# (b) Push it into the backend container so ingest sees it
docker cp scraped_laws.json greeklaywerai-backend-1:/tmp/scraped_laws.json
SCRAPED_LAWS_PATH=/tmp/scraped_laws.json docker exec -i greeklaywerai-backend-1 \
  node src/scripts/ingestLegislation.js
```

(For a permanent setup, mount the repo into the backend container via `docker-compose.yml` so the script auto-picks up `<repo-root>/scraped_laws.json` with no `SCRAPED_LAWS_PATH` override.)

**Why exit 1 on any failure:** operators running this from a CI cron would otherwise silently accumulate a partial ingest that skews pgvector similarity scores. The per-row `[ingest] Failed to ingest …` log line enumerates each failure for triage.

### `legalBenchmarks.js` (Phase 19)

```bash
node src/scripts/legalBenchmarks.js
```

Runs ~7 legal Q&A scenarios through RAG → Gemma and reports response lengths/latencies. Foundation for a future harness using GPT-4-as-judge.

---

## Greek Law Scraping Pipeline

Documented in detail in [`scraping_architecture.md`](scraping_architecture.md) and demonstrated by [`prototype_scraper.py`](prototype_scraper.py).

- **Targets**: Hellenic Parliament, Official Gazette (FEK), N-Lex, ECOLEX, FAOLEX, NATLEX, WIPO Lex.
- **Output schema**: unified JSON with `id`, `source`, `law_title`, `law_number`, `fek_reference`, `publication_date`, `source_url`, `pdf_url`, `full_text`, `status`, `metadata`, `scraped_at`.
- **Phases**: bulk historical scrape → daily incremental scrape with dedupe.
- **Ethics**: rate-limited, rotating user-agents, exponential backoff, robots.txt compliant.

### End-to-end flow (Phase 26)

```
prototype_scraper.py  →  scraped_laws.json  →  ingestLegislation.js  →  legislation_embeddings  →  /api/ai/query RAG retrieval
   (Python 3.10+)         (unified JSON)        (Node CLI, idempotent)         (pgvector HNSW)            (real Greek legal context)
```

`ingestLegislation.js` reads `scraped_laws.json` from the repo root (or `SCRAPED_LAWS_PATH`), normalizes each law's schema fields into the DB row shape, vectorizes via `nomic-embed-text`, and INSERTs with a SELECT-then-INSERT guard so re-runs are idempotent. After every scrape refresh, operators rerun the ingest and the chat UI's `/api/ai/query` endpoint surfaces relevant Άρθρα in the LLM context for every user question.

---

## Testing

### Backend (Jest + Supertest)

```bash
cd backend
npm install
npm test
```

`backend/tests/api.test.js` exercises:

- `POST /api/auth/register` — forced `user` role, blocked admin self-registration (403), duplicate handling, login flow, **Phase 24 register envelope** (`requires_verification: true`, no JWT in response) and unverified-login rejection.
- `POST /api/ai/query` — auth (401), RBAC across `user`/`enterprise`, premium endpoint 403 for `user`.
- `POST /api/ai/audio-query`, `/multimodal` — RBAC matrix.
- `POST /api/billing/create-checkout-session` — RBAC matrix and mocked Stripe success URL.
- `GET /api/admin/users`, `PATCH /api/admin/users/:id/role` — RBAC + invalid role rejection.

`backend/tests/forgotReset.test.js` (Phase 23): 12 cases — happy `inserts a token row`, malformed email does NOT insert, unknown email still returns 200 (anti-enumeration), happy `consumes a reset token and auto-logs in`, malformed token on `/reset-password`, expired token, already-used token, body-too-long DoS clamp, missing fields, rate-limit keys honored. Uses an inline express+limiter build via `makeApp()` so each test scopes its own `db` / `emailService` mocks.

`backend/tests/emailVerification.test.js` (Phase 24): 9 cases — register happy-path does NOT mint a JWT (and the response envelope has `requires_verification: true`); register-when-email-taken returns the conflict error **without** minting a token; `/login` rejects unverified; `/verify-email` happy-path on a fresh token (sets `verified_at`, bumps `token_version`); `/verify-email` rejects missing/invalid/expired/used token; `/verify-email` rejects non-hex token (defends against odd-keyed Redis rate-limit entries); `/resend-verification` is always 200 for existing AND unknown AND malformed emails (anti-enumeration) but only re-issues a token when the user exists AND is unverified.

### Frontend (Karma + Jasmine)

```bash
cd frontend
npm install
npm test
```

Coverage includes `AuthService`, `AdminService`, `AiService`, `authGuard`, `adminGuard`, `LoginComponent`, `AdminComponent`, and `AppComponent`.

---

## Security & Privacy

- **Password storage**: bcryptjs with cost factor ≥ 12 at registration, 10 in the bootstrap admin script.
- **JWT auth**: stateless, 24h TTL, secret overridable via env. **Phase 22** adds `token_version` as a JWT claim; `authMiddleware` re-reads the live value from Postgres on every authenticated request and strict-equality-checks it. `tv` mismatch returns 401 *“Session invalidated”*. This is *not* an upper-bound check — passing a smaller tv is treated the same as a missing/garbled one.
- **Session invalidation surface area** (Phase 22): `/change-password`, `/reset-password`, and `/verify-email` all atomically bump `token_version = token_version + 1` in the same UPDATE that performs their primary write. So a stolen JWT can’t outlive: a voluntary rotation, a forgotten-password recovery, or a successful email verification. The bump is hard-baked into the route handler — there's no admin-side “bump-all” button because individual users self-serve invalidation through their own recovery flow.
- **Auth-route rate limiting** (Phase 21): stacked per-IP caps protect the public auth surface from credential stuffing and bulk account creation; per-account caps on `/change-password` (5/min + 20/day) defend against a stolen-JWT-driven brute force; per-email caps on `/forgot-password` and `/resend-verification` (3/hr) block address-spam enumeration. All caps are env-overridable and honored by tests via `1000-iteration TEST_CEILING`. Redis-backed in production; `passOnStoreError: true` so a Redis blip fails open rather than 500-ing the world.
- **Email verification at registration** (Phase 24): `verified_at IS NULL` rows can never receive a JWT, even with a correct password. Verification tokens are SHA-256-hashed at rest with a 24-hour TTL and a partial unique index on `(token_hash) WHERE used_at IS NULL` for DB-level single-use. The signup flow never sends account-bearing data until `/verify-email` consumes a row, so a leaked DB dump cannot impersonate as-yet-unverified accounts.
- **Password reset tokens**: SHA-256-hashed at rest with 1-hour TTL and the same partial unique index shape. `/reset-password`'s `BEGIN / SELECT / UPDATE used_at (compare-and-set) / UPDATE users (password_hash + token_version + 1) / COMMIT` is atomic — a crash between the two UPDATEs rolls back, so an admin query for “consumed tokens without a password change” always returns zero rows.
- **Anti-enumeration on recovery endpoints**: `/forgot-password` and `/resend-verification` ALWAYS return 200 with the same generic `{ ok: true }` body, regardless of whether the email exists. A 50–200 ms random jitter smooths response-time differences between “user exists” and “user does not exist” so a high-resolution timer can't distinguish the two paths. **`/resend-verification` re-issues only when the user exists AND is unverified** so already-active accounts don't get pointless re-sends.
- **Capped email body length**: 320-char clamp on every email-shaped request body (RFC 5321's 254-char theoretical limit + headroom). Without this clamp, an attacker could submit a multi-MB email string that flows straight into a per-email Redis rate-limit key.
- **Role-based access control**: enforced twice — first at the route level by `rbacMiddleware`, then again at the query layer where sensitive updates (e.g. admin role changes) are blocked server-side.
- **Self-demotion guard**: admins cannot demote themselves via the API (409) or the UI (disabled control + client-side check).
- **Privacy Shield** (GDPR): logs scrubbed of PII, responses flagged `no-store`, requests stamped as locally processed so the `/health` endpoint can advertise it.
- **File uploads**: capped at 25 MB by `multer` to mitigate trivial DoS on `/api/ai/*`.
- **Strict input validation**: numeric IDs parsed with `Number.isInteger`, role/tier values checked against allow-lists before any DB write.

---

## Production Deployment (GPU)

`docker-compose.prod.yml` extends the dev stack with:

- `NODE_ENV=production` baked into the backend.
- `restart: always` on every service.
- **NVIDIA GPU pass-through** enabled for the Ollama container (`driver: nvidia`, `count: 1`, `capabilities: [gpu]`). Requires the host to have the NVIDIA Container Toolkit installed.
- Frontend re-mapped from 4200 → **port 80** for production ingress.
- Secrets sourced from environment variables (`${DB_PASSWORD}`, `${STRIPE_SECRET_KEY}`) instead of baked defaults.

Spin up:

```bash
DB_PASSWORD=$(openssl rand -hex 32) \
STRIPE_SECRET_KEY=sk_live_... \
docker-compose -f docker-compose.prod.yml up -d --build
```

Verify GPU acceleration is working inside the Ollama container:

```bash
docker exec greeklaywerai-ollama-1 nvidia-smi
```

---

## Project Structure

```
.
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.js                      # Express bootstrap
│   │   ├── config/db.js                  # pg pool
│   │   ├── routes/{auth,ai,admin,billing}.js
│   │   ├── services/{ollamaService,ragService,inferenceQueue,emailService}.js
│   │   ├── middlewares/{authMiddleware,privacyShield,rateLimiters}.js
│   │   └── scripts/
│   │       ├── create-admin.js
│   │       ├── migrate-rbac.js
│   │       ├── migrate-token-version.js          # Phase 22
│   │       ├── migrate-password-reset-tokens.js  # Phase 23
│   │       ├── migrate-email-verification.js     # Phase 24
│   │       ├── ingestLegislation.js
│   │       └── legalBenchmarks.js
│   └── tests/
│       ├── app.js                                # Express app under test
│       ├── api.test.js                           # Core auth/AI/billing/admin
│       ├── forgotReset.test.js                   # Phase 23 — forgot/reset flow
│       └── emailVerification.test.js            # Phase 24 — verify/resend flow
│
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── angular.json
│   └── src/app/
│       ├── app.{component,config,routes}.ts
│       ├── components/
│       │   ├── landing/landing.component.ts
│       │   ├── login/    {login.component.ts, login.component.html}
│       │   ├── register/ {register.component.ts, register.component.html}
│       │   ├── forgot-password/{forgot-password.component.ts, .html}
│       │   ├── reset-password/ {reset-password.component.ts, .html}
│       │   ├── change-password/{change-password.component.ts, .html}
│       │   ├── verify-email/   {verify-email.component.ts, .html}
│       │   ├── chat/    chat.component.ts
│       │   └── admin/   admin.component.ts
│       ├── services/{auth,ai,admin}.service.ts
│       ├── shared/auth.constants.ts              # MIN_PASSWORD_LENGTH etc.
│       ├── guards/{auth,admin}.guard.ts
│       └── interceptors/auth.interceptor.ts
│
├── database/
│   └── init/schema.sql                   # pgvector schema, run on first DB boot
│
├── scraped_laws.json                     # Sample output of prototype_scraper.py
├── prototype_scraper.py                  # Python scraping prototype
├── scraping_architecture.md              # Detailed scraping plan
├── docker-compose.yml                    # Dev stack
├── docker-compose.prod.yml               # Production stack (GPU)
└── README.md                             # ← you are here
```

---

## Roadmap

Tracked roughly by phases in the git commit history:

- **Phase 1–6**: Initial scaffolding → auth + RBAC → chat UI with SSE.
- **Phase 7**: Audio query for premium users.
- **Phase 14**: Stripe billing (mock).
- **Phase 15**: Privacy Shield + GDPR header hardening.
- **Phase 16**: BullMQ inference queue (hardware-aware concurrency).
- **Phase 17–18**: Admin UI, RBAC migration, admin-creator script.
- **Phase 19**: Legal accuracy benchmark suite.
- **Phase 20**: Production compose with NVIDIA GPU pass-through.
- **Phase 21**: Auth-route rate limiting (per-IP + per-account + per-email) and Redis-backed `express-rate-limit@7`.
- **Phase 22**: Token-version session invalidation. `/change-password` and `/reset-password` bump `token_version` atomically; `authMiddleware` does strict-equality checking on every authenticated request.
- **Phase 23**: Password recovery flow — `/forgot-password` + `/reset-password` with SHA-256-hashed, single-use, 1h-TTL tokens.
- **Phase 24**: Email verification at registration — `/register` no longer mints a JWT, `/verify-email` and `/resend-verification` complete the flow with SHA-256-hashed, single-use, 24h-TTL tokens.

Next likely steps (open issues):

- Real embeddings: swap `generateEmbedding` mock for `ollama.embeddings()` or Gemini Embeddings API.
- Real Greek legislation ETL: load `scraped_laws.json` into `legislation_embeddings` via an ingestion worker.
- Replace mock Stripe with the real Checkout SDK + webhook handler.
- Tighten the benchmark harness with regex assertions + GPT-4-as-judge for hallucination detection.

---

## License

Internal project — license TBD.
