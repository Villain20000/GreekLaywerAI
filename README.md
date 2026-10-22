# NomosAI — Greek AI Lawyer

> A Greek legal AI workspace: an Angular 17 SPA, an Express/Node API, local
> Ollama inference with a pgvector RAG layer over Greek legislation, Stripe
> subscriptions, GDPR tooling, and a production stack with TLS, observability
> and backups.

---

## Contents

1. [Feature set](#feature-set)
2. [Screenshots](#screenshots)
3. [Architecture](#architecture)
4. [Technology stack](#technology-stack)
5. [Quick start](#quick-start)
6. [Environment variables](#environment-variables)
7. [Database schema & migrations](#database-schema--migrations)
8. [API reference](#api-reference)
9. [Frontend](#frontend)
10. [Services & middlewares](#services--middlewares)
11. [Production operations](#production-operations)
12. [Testing](#testing)
13. [Project structure](#project-structure)
14. [Roadmap](#roadmap)

---

## Feature set

- **Local-first AI** — chat and embeddings run on a local Ollama runtime
  (`gemma2b-mmap` chat, `bge-m3` embeddings, 1024 dimensions). No prompt or
  document leaves the deployment unless the optional Ansvar MCP retrieval is
  enabled, which sends only the chat query text — never uploaded documents —
  to the gateway.
- **Grounded RAG** — legislation retrieval uses the optional Ansvar MCP
  gateway (Streamable HTTP, OAuth client credentials or a bearer token, tool
  discovery) with automatic fallback to the local pgvector HNSW corpus.
  Answers carry structured sources and a confidence score.
- **Real token streaming** — `POST /api/ai/query/live` + SSE
  `GET /api/ai/query/live/:jobId/events` stream model deltas through Redis
  pub/sub (with an in-process fallback when Redis is absent). The legacy
  `/api/ai/query` and `/api/ai/query/stream` polling paths remain.
- **Active inference queue** — BullMQ (concurrency 1) gates the GPU; without
  Redis an inline gate serializes work in-process. Started from `src/index.js`.
- **Multimodal** — audio transcription through a local whisper sidecar;
  PDF/DOCX analysis; scanned PDFs are page-rasterized and OCRed (up to
  `OCR_PDF_MAX_PAGES`, encrypted PDFs rejected); image uploads analyzed by an
  optional Ollama vision model or local Tesseract OCR (`ell+eng`).
- **Accounts & auth** — JWT with `token_version` invalidation, email
  verification, password reset, authenticated email change with confirmation
  to the new address, auth rate limiting, and an opt-in admin magic link.
  Account deletion is scheduled after a configurable grace period
  (`ACCOUNT_DELETION_GRACE_HOURS`) and can be cancelled until the deadline.
- **Stripe billing** — live Checkout + Billing Portal + signature-verified
  webhooks in production; a built-in mock checkout is available in
  development/test only (`sk_test_mock`). Invoice history is persisted and
  exposed per user.
- **Documents** — upload PDF/DOCX/TXT, store the original bytes for download,
  chunk + embed for per-user semantic search, preview extracted text.
- **Admin console** — user role/tier management, audit log, feedback summary,
  cross-user document search with pagination and deletion.
- **Resilience & UX** — global error handler with a translated shell banner,
  optional client-error reporting URL, optional Sentry (backend and frontend),
  PWA (service worker + manifest), SEO metadata with build-time `SITE_URL`
  replacement, sitemap/robots, Greek/English i18n, cursor-paginated chat
  history with a "load older messages" control, and a deterministic,
  client-side A/B experiment (landing hero).
- **Production hardening** — Traefik TLS edge with per-IP rate limiting and
  in-flight request caps, Cloudflare real-IP support in nginx, `*_FILE`
  secrets, Redis response caching, feature flags, Prometheus/Alertmanager/
  Grafana/Loki/Promtail, S3 offsite backups, weekly ZAP baseline scan, and a
  Kubernetes multi-host baseline under `deploy/k8s/`.

---

## Screenshots

Captured from the running development stack with the seeded Greek demo
corpus and demo accounts. Greek is the default UI language; the last image
shows the same workspace in English with the light theme.

| | |
|---|---|
| [![NomosAI landing page](docs/screenshots/01-landing.png)](docs/screenshots/01-landing.png)<br>**Landing** — Three.js brand hero with the landing-hero A/B subtitle. | [![Sign-in page](docs/screenshots/02-login.png)](docs/screenshots/02-login.png)<br>**Sign in** — JWT authentication with recovery and registration links. |
| [![Registration page](docs/screenshots/03-register.png)](docs/screenshots/03-register.png)<br>**Register** — Account creation feeding the email-verification flow. | [![Password recovery request page](docs/screenshots/04-password-recovery.png)](docs/screenshots/04-password-recovery.png)<br>**Password recovery** — Anti-enumeration reset-link request. |
| [![Chat with grounded answer and citations](docs/screenshots/05-chat-grounded-answer.png)](docs/screenshots/05-chat-grounded-answer.png)<br>**Grounded chat** — RAG answer with four citations, 90% confidence and feedback. | [![Greek tax-law answer](docs/screenshots/06-chat-legal-answer.png)](docs/screenshots/06-chat-legal-answer.png)<br>**Legal Q&amp;A** — Markdown answer with source and confidence badge. |
| [![Conversation history](docs/screenshots/07-conversations.png)](docs/screenshots/07-conversations.png)<br>**Conversations** — Searchable history with rename, delete and pagination. | [![Documents page](docs/screenshots/08-documents.png)](docs/screenshots/08-documents.png)<br>**Documents** — Upload dropzone, semantic search and per-user files. |
| [![Document preview](docs/screenshots/09-document-preview.png)](docs/screenshots/09-document-preview.png)<br>**Document preview** — Extracted text from a stored court decision. | [![Plans and billing](docs/screenshots/10-plans-billing.png)](docs/screenshots/10-plans-billing.png)<br>**Plans** — Server-owned catalog with the current Pro plan highlighted. |
| [![Subscriptions and invoices](docs/screenshots/11-subscriptions-invoices.png)](docs/screenshots/11-subscriptions-invoices.png)<br>**Subscription &amp; invoices** — Status history and paginated Stripe invoices. | [![Profile and GDPR controls](docs/screenshots/12-profile-gdpr.png)](docs/screenshots/12-profile-gdpr.png)<br>**Profile &amp; GDPR** — Email change, daily quotas, export and deletion. |
| [![Change password page](docs/screenshots/13-change-password.png)](docs/screenshots/13-change-password.png)<br>**Change password** — Password rotation invalidates other sessions. | [![Admin console](docs/screenshots/14-admin-console.png)](docs/screenshots/14-admin-console.png)<br>**Admin console** — Roles and tiers, answer quality and the audit log. |
| [![Admin document management](docs/screenshots/15-admin-documents.png)](docs/screenshots/15-admin-documents.png)<br>**Admin documents** — Cross-user search and administrative deletion. | [![Email verification error state](docs/screenshots/16-verify-email.png)](docs/screenshots/16-verify-email.png)<br>**Verify email** — Single-use token error state. |
| [![Password reset form](docs/screenshots/17-reset-password.png)](docs/screenshots/17-reset-password.png)<br>**Reset password** — One-time token with password confirmation. | [![Admin magic link error state](docs/screenshots/18-admin-magic-link.png)](docs/screenshots/18-admin-magic-link.png)<br>**Admin magic link** — Admin-only redemption, invalid-token state. |
| [![404 page](docs/screenshots/19-not-found.png)](docs/screenshots/19-not-found.png)<br>**Not found** — Localized 404 surface. | [![English interface with light theme](docs/screenshots/20-chat-english-light.png)](docs/screenshots/20-chat-english-light.png)<br>**English &amp; light theme** — The same workspace, localized and re-themed. |

---

## Architecture

```
Browser (same origin)
   │
   ▼
Cloudflare (optional: WAF/CDN/DDoS, account-side)
   │
   ▼
Traefik (prod/staging, TLS, edge rate limits) ──▶ frontend nginx :80
                                                   ├─ static SPA + PWA
                                                   └─ /api/ ──▶ backend :3000
                                                                   ├─ PostgreSQL 16 + pgvector
                                                                   ├─ Redis 7 (queue, rate limits, cache, SSE)
                                                                   ├─ Ollama (gemma2b-mmap + bge-m3)
                                                                   ├─ whisper (faster-whisper)
                                                                   └─ Ansvar MCP (optional; query text only)
```

The compose stacks run on one host. `deploy/k8s/` moves the same frontend/
backend pair onto Kubernetes with external PostgreSQL, Redis and Ollama.

When Ansvar credentials are configured, legislation retrieval goes to the
external MCP gateway first; any failure or empty result falls back to the
local pgvector corpus. Uploaded documents are only ever embedded and searched
locally.

The SPA always calls `/api/*` on its own origin; the dev server proxies to the
backend and nginx proxies in production, so no CORS or hostname is baked into
the bundle.

---

## Technology stack

| Layer | Tech |
|---|---|
| Frontend | Angular 17 standalone components, RxJS, ngx-translate (el/en), GSAP, Three.js, Angular Service Worker |
| Backend | Node.js 20, Express, jsonwebtoken, bcryptjs, multer, helmet, express-rate-limit, pino |
| Data | PostgreSQL + pgvector (HNSW cosine), Redis 7 |
| AI | Ollama (`gemma2b-mmap`, `bge-m3`), Tesseract.js OCR, optional Ollama vision model, faster-whisper sidecar |
| Legal retrieval | Optional Ansvar MCP gateway (Streamable HTTP) with local pgvector fallback |
| Billing | Stripe SDK (Checkout, Billing Portal, webhooks) with a dev-only mock mode |
| Infra | Docker Compose (dev/staging/prod), Traefik v3, NVIDIA Container Toolkit in prod |
| Scraping | Python 3.10+ prototype (`prototype_scraper.py`) |

---

## Quick start

### Prerequisites

- Docker 24+ and Docker Compose v2
- *(Optional)* NVIDIA GPU + NVIDIA Container Toolkit for accelerated inference
- Free ports: `4200`, `3000`, `5432`, `6379`, `11434`

### Development stack

```bash
docker compose up --build
```

| Container | Image | Port |
|---|---|---|
| `frontend` | built from `./frontend` | 4200 |
| `backend` | built from `./backend` | 3000 |
| `db` | `ankane/pgvector:v0.5.1` | 5432 |
| `redis` | `redis:7-alpine` | 6379 |
| `ollama` | `ollama/ollama` | 11434 |
| `whisper` | `ghcr.io/speaches-ai/speaches:latest-cpu` | internal |

### First admin

```bash
docker compose exec backend node src/scripts/create-admin.js admin@nomos.ai 'ChangeMe123!'
```

`create-admin.js` inserts the row with `verified_at = NULL`. Either open the
`[DEV-EMAIL] ... Verify URL` line from `docker compose logs backend`, or mark
the address verified directly:

```bash
docker compose exec db psql -U nomos_admin -d nomos_db \
  -c "UPDATE users SET verified_at = NOW() WHERE email='admin@nomos.ai';"
```

Production/staging use real SMTP, so the verification email arrives normally.

### Seed legislation

```bash
docker compose exec backend node src/scripts/ingestLegislation.js
```

The script reads `scraped_laws.json` (or `SCRAPED_LAWS_PATH`), embeds each row
with `bge-m3`, and is idempotent. When the corpus is absent it falls back to a
3-article mock set — **dev only**: production refuses unless
`ALLOW_MOCK_CORPUS=true`.

### Migrations

`database/init/schema.sql` runs only on a brand-new Postgres volume. Existing
databases use the idempotent runner:

```bash
docker compose exec backend npm run migrate
```

It applies, in order: `migrate-rbac`, `migrate-token-version`,
`migrate-password-reset-tokens`, `migrate-email-verification`,
`migrate-phase-29-schema`, **`migrate-invoices`**, **`migrate-email-change`**,
**`migrate-document-originals`**, `migrate-webhook-events`,
`migrate-account-deletion`, `migrate-subscriptions-integrity`,
`migrate-usage-counters`, `migrate-phase-a-reliability`,
`migrate-phase-b-citations`, `migrate-phase-c-feedback`,
`migrate-vector-cosine-indexes`, `migrate-legislation-unique-index`.

---

## Environment variables

### Secrets from files

Every supported secret can be supplied as `<NAME>_FILE=/path` instead of the
plain variable. The file is read as UTF-8, trailing CR/LF is stripped, and the
file value takes precedence over the environment. A configured-but-unreadable
file aborts startup. Supported names: `DB_PASSWORD`, `JWT_SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_USER`, `SMTP_PASS`,
`ANSVAR_CLIENT_SECRET`, `ANSVAR_MCP_TOKEN`.
Compose interpolation still requires the plain variables, so keep a
non-sensitive placeholder when using files.

### Ansvar MCP (optional Greek-law retrieval)

RAG uses the local pgvector corpus by default. To query Greek legislation
through the Ansvar gateway instead, register an OAuth client with the
`mcp:tools` scope (or obtain a bearer token) and configure:

```dotenv
ANSVAR_CLIENT_ID=your-client-id
ANSVAR_CLIENT_SECRET=your-client-secret
# or: ANSVAR_MCP_TOKEN=<bearer-token>
#ANSVAR_MCP_ENABLED=true
#ANSVAR_TOOL_NAME=...
#ANSVAR_TOOL_ARGS={"query":"{{query}}","limit":"{{limit}}","jurisdiction":"GR"}
```

The backend performs the MCP Streamable HTTP handshake, lists the gateway
tools, and calls the best-matching search tool (or the pinned
`ANSVAR_TOOL_NAME`). Results are normalized into the same citation shape as
the local corpus, cached in Redis, and any error or empty result falls back
to pgvector. Only the chat query text is sent; uploaded document contents
never leave the deployment. `GET /health` reports the integration under
`checks.ansvar`, and `GET /api/ai/health` exposes `retrievalProvider`.

### Backend

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | *(unset)* | `production` enables boot guards and the SMTP requirement |
| `PORT` | `3000` | Express port |
| `LOG_LEVEL` | `info` | pino log level |
| `TRUST_PROXY` | `uniquelocal,loopback` | Proxy hops/CIDRs for `req.ip` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_NAME` | `localhost` / `5432` / `nomos_admin` / `nomos_db` | PostgreSQL |
| `DB_PASSWORD` | `nomos_password` | PostgreSQL password (`DB_PASSWORD_FILE` supported) |
| `REDIS_URL` | `redis://redis:6379` | Queue, rate limits, response cache, SSE |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama base URL |
| `OLLAMA_CHAT_MODEL` | `gemma2b-mmap` | Chat model |
| `OLLAMA_EMBED_MODEL` / `OLLAMA_EMBED_DIM` | `bge-m3` / `1024` | Embeddings; dimension must match the vector column |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-call chat/embedding timeout |
| `OLLAMA_VISION_MODEL` | *(empty)* | Optional vision model (e.g. `llava`); empty disables it |
| `OLLAMA_VISION_TIMEOUT_MS` | `120000` | Vision request timeout |
| `OCR_LANGUAGES` | `ell+eng` | Tesseract language packs |
| `OCR_TIMEOUT_MS` | `30000` | OCR deadline (applied to queue + recognition) |
| `OCR_PDF_MAX_PAGES` / `OCR_PDF_SCALE` / `OCR_PDF_TIMEOUT_MS` | `10` / `2` / `120000` | Scanned-PDF rasterization limits and shared OCR deadline |
| `WHISPER_URL` | `http://whisper:8000` | Local speech-to-text sidecar; `disabled` turns STT off |
| `WHISPER_MODEL` | `Systran/faster-whisper-base` | Model preloaded by the sidecar |
| `WHISPER_TIMEOUT_MS` | `120000` | Transcription timeout |
| `JWT_SECRET` | dev fallback | Must be overridden in production (`JWT_SECRET_FILE`) |
| `STRIPE_SECRET_KEY` | `sk_test_mock` | Live key enables Checkout/Portal; `sk_test_mock` = mock mode |
| `STRIPE_PRICE_ID_BASIC` / `_PRO` / `_ENTERPRISE` | — | Stripe price IDs |
| `STRIPE_WEBHOOK_SECRET` | — | Webhook signature verification |
| `APP_BASE_URL` | `http://localhost:4200` | Links in emails and Stripe redirects |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allow-list; empty mirrors all origins (dev) |
| `ACCOUNT_DELETION_GRACE_HOURS` | `24` | Delay before a scheduled account deletion is purged (1-168) |
| `SENTRY_DSN` | *(empty)* | Optional backend Sentry DSN; empty disables the SDK |
| `SENTRY_ENVIRONMENT` / `SENTRY_TRACES_SAMPLE_RATE` | `NODE_ENV` / `0` | Sentry environment and tracing rate (0..1) |
| `AB_EXPERIMENTS` | *(empty)* | JSON experiment config; empty uses the landing-hero 50/50 default |
| `EMAIL_TRANSPORT` | `console` | `smtp` in production; console transport refuses to run there |
| `EMAIL_FROM` / `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | — / — / `587` / `false` | SMTP delivery |
| `SMTP_USER` / `SMTP_PASS` | — | Optional SMTP auth |
| `AI_QUERY_TIMEOUT_MS` | `120000` | Synchronous query budget (504 afterwards) |
| `AI_UPLOAD_MAX_BYTES` | `26214400` | Upload cap for AI endpoints (25 MB) |
| `AI_STREAM_TTL_MS` | `600000` | SSE stream/event retention |
| `AI_STREAM_MAX_LOG_EVENTS` | `5000` | Max buffered events per stream |
| `AI_STREAM_PUBLISH_TIMEOUT_MS` / `AI_STREAM_SUBSCRIBE_TIMEOUT_MS` | `2000` / `5000` | Redis pub/sub deadlines |
| `AI_STREAM_REDIS_COOLDOWN_MS` | `30000` | Fallback-to-local period after a Redis failure |
| `RAG_CACHE_TTL_SECONDS` | `300` | Legislation retrieval cache TTL |
| `ANSVAR_MCP_ENABLED` | auto | Enable Ansvar when credentials are present; `false` forces local pgvector |
| `ANSVAR_MCP_URL` | `https://gateway.ansvar.eu/mcp` | MCP Streamable HTTP endpoint |
| `ANSVAR_CLIENT_ID` / `ANSVAR_CLIENT_SECRET` | — | OAuth client-credentials client (`ANSVAR_CLIENT_SECRET_FILE` supported) |
| `ANSVAR_MCP_TOKEN` | — | Pre-issued bearer token; takes precedence over client credentials (`ANSVAR_MCP_TOKEN_FILE` supported) |
| `ANSVAR_SCOPE` | `mcp:tools` | OAuth scope requested from the token endpoint |
| `ANSVAR_TOKEN_URL` | Keycloak realm token endpoint | OAuth token endpoint |
| `ANSVAR_TOOL_NAME` | auto | Pin the MCP search tool |
| `ANSVAR_TOOL_ARGS` | auto | JSON argument template with `{{query}}` and `{{limit}}` |
| `ANSVAR_TIMEOUT_MS` / `ANSVAR_SESSION_TTL_MS` | `20000` / `300000` | Retrieval deadline and MCP session reuse TTL |
| `PLANS_CACHE_TTL_SECONDS` | `3600` | Billing plan catalog cache TTL |
| `CACHE_PREFIX` | `nomos:cache` | Redis key namespace |
| `FEATURE_FLAGS` | *(empty)* | `name` enables, `name:false` disables; known: `billing`, `documents`, `audio`, `adminDocuments` |
| `QUOTA_AI_BASIC` / `_PRO` / `_ENTERPRISE` | `20` / `60` / `120` | Daily AI query caps |
| `QUOTA_DOCS_BASIC` / `_PRO` / `_ENTERPRISE` | `10` / `50` / `unlimited` | Document caps |
| `RETENTION_CONVERSATIONS_DAYS` / `_DOCUMENTS_DAYS` / `_AUDIT_LOG_DAYS` | `365` / `365` / `90` | Retention cleanup |
| `BACKUP_DIR` | `backend/backups` | Local dump directory |
| `BACKUP_S3_BUCKET` | *(empty)* | Offsite S3-compatible upload |
| `S3_REGION` / `S3_ENDPOINT` / `S3_FORCE_PATH_STYLE` / `S3_PREFIX` / `S3_SSE` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `us-east-1` fallback / — / `false` / `nomosai/` / — / — / — | S3 settings; when keys are unset the AWS default chain (`AWS_*`) is used |
| `GRAFANA_PORT` / `GRAFANA_ADMIN_PASSWORD` | `3001` / — | Loopback-only Grafana (monitoring profile) |
| `SLACK_WEBHOOK_URL` / `SLACK_CHANNEL` | — | Alertmanager Slack routing |
| `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` / `SMTP_REQUIRE_TLS` | — | Alertmanager email routing |
| `EDGE_RATE_LIMIT_AVERAGE` / `EDGE_RATE_LIMIT_BURST` | `50` / `100` | Traefik edge requests/second and burst |
| `EDGE_INFLIGHT_REQ_AMOUNT` | `100` | Traefik concurrent in-flight request cap |
| `ADMIN_MAGIC_LINK_ENABLED` | `false` | Must be `true` to mint/redeem admin magic links in production |
| `SCRAPED_LAWS_PATH` | `<repo>/scraped_laws.json` | Scraper output consumed by the ingest script |
| `ALLOW_MOCK_CORPUS` | `false` | Allow the 3-article fallback corpus in production |
| `INLINE_JOB_TTL_MS` / `INLINE_JOB_PRUNE_INTERVAL_MS` / `INLINE_QUEUE_CONCURRENCY` | `600000` / `60000` / `1` | No-Redis job retention/concurrency |
| `INFERENCE_QUEUE_*` | see `.env.example` | Retries, backoff, lock/stall and retention tuning |

### Frontend

There are no runtime env vars. `src/environments/environment*.ts` holds
`apiBaseUrl` (empty = same origin) and `errorReportingUrl` (empty disables
client-error reporting; set an absolute URL or `/api/client-errors` at build
time to enable it). `sentryDsn` / `sentryTracesSampleRate` are also build-time
values; the SDK is a no-op when the DSN is empty.

`SITE_URL` (default `https://your-domain.gr`) is a Docker build arg:
`npm run build` runs `ng build` followed by `scripts/apply-site-url.js`,
which rewrites the placeholder origin in the built `index.html`,
`sitemap.xml` and `robots.txt`. Set it before building each deployment
(`docker build --build-arg SITE_URL=https://app.example.com ./frontend` or
`SITE_URL=... docker compose build frontend`).

---

## Database schema & migrations

Tables created by `database/init/schema.sql`:

| Table | Purpose |
|---|---|
| `users` | Accounts, role/tier, `token_version`, `verified_at`, `deletion_scheduled_for` |
| `subscriptions` | Stripe customer/subscription linkage |
| `invoices` | Persisted invoice/payment history (webhook-populated) |
| `usage_counters` | Daily AI quota counters |
| `stripe_webhook_events` | Webhook idempotency |
| `conversations` / `messages` / `message_feedback` | Chat history, citations, ratings |
| `legal_documents` | Uploads incl. `original_file BYTEA` + `file_size` |
| `legal_document_chunks` | Extracted chunks + embeddings |
| `legislation_embeddings` | Greek legislation chunks, `vector(1024)` |
| `audit_log` | Security/business audit trail |
| `password_reset_tokens` / `email_verification_tokens` / `email_change_tokens` | SHA-256-hashed, single-use tokens |

Indexes include HNSW cosine on `legislation_embeddings.embedding`, B-tree
lookups on token hashes, and partial unique indexes on unused token hashes.
Parity between the init schema and every `migrate-*.js` script is pinned by
`backend/tests/migrationParity.test.js`.

---

## API reference

Base URL: same origin as the SPA (`/api/...`). Authenticated routes use
`Authorization: Bearer <JWT>`.

### Health & metrics

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | public | DB/Redis/queue/Ollama/Stripe checks; 503 when DB or Redis is down |
| GET | `/api/ai/health` | public | Ollama warmup status |
| GET | `/api/config` | public | `{ features: { ... }, experiments: { ... } }` |
| GET | `/metrics` | public* | Prometheus metrics; keep it internal at the edge |

\* Prometheus scrapes it over the private compose network.

### Auth (`/api/auth`)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/register` | `{ email, password }` | Creates an unverified user; no JWT until verification |
| POST | `/login` | `{ email, password }` | `{ token, user }`; unverified accounts are rejected |
| GET | `/me` | — | Live user row |
| POST | `/change-password` | `{ currentPassword, newPassword }` | Returns a rotated JWT |
| POST | `/forgot-password` | `{ email }` | Always 200 (anti-enumeration) |
| POST | `/reset-password` | `{ token, newPassword }` | Consumes token, bumps `token_version`, returns JWT |
| POST | `/verify-email` | `{ token }` | Sets `verified_at`, returns JWT |
| POST | `/change-email` | `{ currentPassword, newEmail }` | Requires JWT; mails a confirmation link to the **new** address |
| POST | `/verify-email-change` | `{ token }` | Atomic email swap + `token_version` bump, returns JWT |
| POST | `/resend-verification` | `{ email }` | Always 200 |
| POST | `/admin-magic-link/redeem` | `{ token }` | Off unless enabled (see `ADMIN_MAGIC_LINK_ENABLED`) |

Token tables store SHA-256 hashes only. Reset/verification/change tokens are
single-use and expire (1 h reset, 24 h verification/change).

### AI (`/api/ai`)

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/query` | user, admin, enterprise | Queued synchronous answer |
| POST | `/query/stream` | user, admin, enterprise | Enqueue; poll the job below |
| GET | `/query/stream/:jobId` | owner | `{ status, result? , error? }` |
| DELETE | `/query/stream/:jobId` | owner | Best-effort cancellation of waiting jobs |
| POST | `/query/live` | user, admin, enterprise | `{ jobId }` for a live SSE job |
| GET | `/query/live/:jobId/events` | owner | SSE `chunk`, `done`, `error` events |
| POST | `/audio-query` | admin, enterprise | Multipart audio → whisper → RAG answer |
| POST | `/multimodal` | admin, enterprise | PDF/DOCX/image; images use vision or OCR |
| POST | `/messages/:messageId/feedback` | owner | `{ helpful, reason? }`, replaces prior vote |
| GET | `/models` | auth mount | Resolved chat/embed models |

Scanned PDFs without a text layer are rasterized (mupdf) and OCRed page by
page; encrypted/password-protected PDFs are rejected by the OCR path (the
multimodal endpoint returns 422). Limits: `OCR_PDF_MAX_PAGES`,
`OCR_PDF_SCALE`, `OCR_PDF_TIMEOUT_MS`. Image uploads are OCR'd/vision-analyzed.

### Billing (`/api/billing`) and subscriptions (`/api/subscriptions`)

| Method | Path | Notes |
|---|---|---|
| GET | `/billing/plans` | Server-owned plan catalog (cached) |
| POST | `/billing/create-checkout-session` | `{ tier }` → Stripe Checkout or mock URL |
| POST | `/billing/portal` | Stripe Billing Portal; live mode only |
| POST | `/billing/mock-complete` | Dev-only mock completion; 403 in live mode |
| POST | `/billing/webhook` | Stripe signature-verified; raw body, no auth header |
| GET | `/subscriptions` | Current subscription |
| GET | `/subscriptions/history` | Full subscription history |
| GET | `/subscriptions/invoices?limit=&offset=` | Paginated invoices (`limit` ≤ 100) |
| GET | `/subscriptions/usage` | Read-only quota usage |
| POST | `/subscriptions/cancel` / `/reactivate` / `/upgrade` | Cancel, undo cancellation, checkout |

Webhook events handled: `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`.
Register the endpoint (and print a new signing secret once) with
`npm run stripe:webhook`; see
[`docs/production-hardening.md`](docs/production-hardening.md#stripe-webhook-registration).

### Documents (`/api/documents`)

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Multipart upload (PDF/DOCX/TXT, 25 MB) |
| GET | `/` | Paginated list |
| GET | `/:id` | Metadata + chunk count |
| GET | `/:id/content` | Original file download; `?format=text` returns extracted text |
| DELETE | `/:id` | Delete document + chunks |
| POST | `/search` | Semantic search over the user's chunks |

### Admin (`/api/admin`, admin only)

`GET /users`, `PATCH /users/:id/role`, `PATCH /users/:id/tier`,
`GET /audit-log`, `GET /feedback-summary`, and
`GET /documents?q=&userId=&limit=&offset=` (filename/title/owner email search,
pagination), `DELETE /documents/:id`.

### Other

- `/api/conversations` — list/create/read/rename/delete.
  `GET /api/conversations/:id?messageLimit=30&before=<messageId>` returns the
  newest message page plus `hasMore` / `nextCursor`; omit `messageLimit` for
  the legacy full-history response. The chat UI loads older pages on demand.
- `/api/gdpr/export` — data export.
- `/api/gdpr/account` — `DELETE` with `{ confirm: true, email }` schedules
  deletion after `ACCOUNT_DELETION_GRACE_HOURS` (default 24; repeated calls do
  not extend the deadline).
- `/api/gdpr/deletion-status` — `{ deletionScheduledFor }` for the current
  account.
- `/api/gdpr/cancel-deletion` — clears a pending deadline (409 if none).
- `/api/auth/*`, `/api/ai/*`, `/api/billing/*`, `/api/subscriptions/*`,
  `/api/documents/*`, `/api/gdpr/*` are rate-limited; see
  `middlewares/rateLimiters.js` for exact caps.

---

## Frontend

Routes: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`,
`/verify-email`, `/admin-login`, `/chat`, `/change-password`, `/documents`,
`/conversations`, `/billing`, `/subscriptions`, `/profile`, `/admin`,
`/admin/documents`, and a Greek 404 page.

- **i18n** — Greek default + English; dictionaries must stay key-identical
  (pinned by `i18n.spec.ts`).
- **PWA** — `manifest.webmanifest`, 192/512 icons, Angular service worker
  generated only in production. nginx serves the manifest as
  `application/manifest+json` and never caches `ngsw-worker.js`, `ngsw.json`
  or `index.html`.
- **SEO** — canonical/OG/Twitter metadata in `index.html`, `robots.txt` and
  `sitemap.xml` at the origin root, content-hashed assets cached immutable.
- **Resilience** — `GlobalErrorHandler` shows a translated banner and can POST
  errors to `environment.errorReportingUrl`; the service worker is registered
  after stabilization.
- **Security headers** — nginx adds `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin` and a
  `Permissions-Policy`; the API adds CSP/HSTS-family headers via helmet.
- **A/B experiments** — `GET /api/config` returns validated weighted variants
  from `AB_EXPERIMENTS` (JSON). `ExperimentService` hashes a persistent client
  id for deterministic assignment; the shipped experiment is
  `landing-hero` (`control` / `variant`, 50/50 by default). No exposure
  analytics are emitted; assignment is client-side only.

---

## Services & middlewares

- **`inferenceQueue.js`** — BullMQ queue + concurrency-1 worker; inline
  fallback without Redis. Streaming jobs publish deltas to `streamHub`.
- **`streamHub.js`** — Redis pub/sub channels with buffering/replay, TTL,
  capped event logs and a local fallback after Redis failures.
- **`ollamaService.js`** — chat, token streaming, embeddings, warmup, shared
  abort timeout; canonical Greek legal system prompt.
- **`ragService.js`** — real `bge-m3` embeddings, pgvector cosine search,
  Redis-cached retrieval, context/source formatting. Delegates legislation
  retrieval to Ansvar when configured and falls back to pgvector on failure.
- **`ansvarMcpService.js`** — optional Greek-law retrieval over MCP
  Streamable HTTP: OAuth client credentials or a static bearer token, tool
  discovery/pinning, argument inference, session/token reuse and result
  normalization. Never sends uploaded documents.
- **`ocrService.js` / `pdfRasterService.js` / `visionService.js`** — serialized
  Tesseract OCR, scanned-PDF page rasterization with typed errors, and optional
  Ollama vision (`OLLAMA_VISION_MODEL`), with vision→OCR fallback.
- **`stripeService.js`** — mock/live checkout, portal, plan catalog,
  subscription upserts, invoice persistence, webhook handling.
  `scripts/configure-stripe-webhook.js` registers the endpoint idempotently.
- **`config/sentry.js`** — optional backend Sentry init; no-op without a DSN.
- **`experiment.service.ts`** — fetches `/api/config` experiments and assigns
  variants deterministically from a hashed client id; no exposure events.
- **`emailService.js`** — console transport for dev, SMTP for
  production/staging; password-reset, verification and email-change messages.
- **`cacheService.js`** — namespaced, fail-open Redis JSON cache.
- **`secrets.js`** — `*_FILE` resolution with plain-variable fallback.
- **Middlewares** — `authMiddleware` (token_version check), RBAC, privacy
  shield, rate limiters, quotas, Prometheus metrics, request logging, global
  error handler.

---

## Production operations

- **Compose / TLS** — `docker-compose.prod.yml` runs Traefik v3.7 as the only
  public edge (`HTTP_PORT`/`HTTPS_PORT`, Let's Encrypt production ACME);
  nginx serves the SPA and proxies `/api/`. Staging mirrors this with the
  Let's Encrypt staging CA by default. See
  [`docs/production-hardening.md`](docs/production-hardening.md) and
  [`docs/staging-deployment.md`](docs/staging-deployment.md).
- **Edge protection** — Traefik adds configurable per-IP rate limiting
  (`EDGE_RATE_LIMIT_AVERAGE`/`_BURST`) and an in-flight request cap. Cloudflare
  real-IP ranges are mounted into nginx from `deploy/cloudflare/real-ip.conf`;
  WAF/CDN/cache/DDoS are account-side controls documented in
  [`deploy/cloudflare/README.md`](deploy/cloudflare/README.md).
- **Kubernetes** — [`deploy/k8s/`](deploy/k8s/README.md) provides 2+ replica
  backend/frontend Deployments, a dedicated single-replica BullMQ worker
  (web pods set `QUEUE_WORKER_ENABLED=false` so GPU concurrency stays at 1),
  Services, an HPA, probes, resource limits and an Ingress against external
  PostgreSQL/Redis/Ollama. Compose remains the single-host default.
- **Sentry (optional)** — backend DSN/rates via env, frontend DSN at build
  time; both are inert without a DSN. See
  [`docs/observability.md`](docs/observability.md).
- **Secrets** — `.env.production` / `.env.staging` (mode `0600`, both ignored
  by git) plus optional Docker secret files via `*_FILE`.
- **Observability** — optional `--profile monitoring` adds Prometheus,
  Alertmanager (Slack/email), Grafana (loopback only), Loki and Promtail.
  Alerts cover backend down, 5xx rate, queue depth, Redis, disk space and
  backup freshness. See [`docs/observability.md`](docs/observability.md).
- **Backups** — daily `pg_dump` into a named volume, optional S3-compatible
  upload, freshness metric, restore CLI and drill. See
  [`docs/backup-restore.md`](docs/backup-restore.md).
- **DAST** — `.github/workflows/zap.yml` runs a weekly ZAP baseline scan
  against `STAGING_BASE_URL`.
- **Feature flags** — `FEATURE_FLAGS` controls SPA features through
  `GET /api/config`; flags default to enabled.
- **Caching** — RAG retrieval and the plan catalog are cached in Redis with
  configurable TTLs; every cache path fails open.
- **Ansvar MCP (optional)** — opt-in external Greek-law retrieval over MCP
  Streamable HTTP with OAuth client credentials or a bearer token. Only the
  chat query text is sent; uploaded documents remain local. Failures fall back
  to pgvector, and status is exposed under `checks.ansvar` on `/health`.

---

## Testing

### Backend

```bash
cd backend
npm test -- --runInBand
```

Jest + Supertest covers auth/verification/email-change, AI routes and live
streaming, queue hardening, multimodal OCR/vision, RAG cache, Ansvar MCP
handshake/normalization and pgvector fallback, billing/invoices,
webhooks, document originals, admin search, quotas, rate limits, migrations,
compose/monitoring configuration and backup/restore.

### Frontend

```bash
cd frontend
npx tsc -p tsconfig.spec.json --noEmit
npx ngc -p tsconfig.app.json --noEmit
npm test          # Karma + Jasmine; needs a Chrome/Chromium binary
npm run build     # production build incl. service worker
```

Karma is memory-hungry in constrained environments; the type-checks above are
the fast, deterministic gate.

---

## Project structure

```
backend/
  src/
    config/{db,secrets}.js
    routes/{auth,ai,aiStream,billing,subscriptions,documents,admin,conversations,gdpr,webhook,config}.js
    services/{ollamaService,ragService,ansvarMcpService,inferenceQueue,streamHub,ocrService,visionService,
              documentService,stripeService,emailService,cacheService,quotaService,auditLog}.js
    middlewares/{authMiddleware,rateLimiters,quotaMiddleware,privacyShield,security,metrics,requestLogger}.js
    scripts/{migrate-all,migrate-invoices,migrate-email-change,migrate-document-originals,
             backupDb,restoreDb,retentionCleanup,ingestLegislation,...}.js
  tests/
frontend/
  src/app/{components,services,guards,i18n}/
  src/assets/{i18n,icons,sitemap.xml,robots.txt}
  scripts/apply-site-url.js, nginx.conf, ngsw-config.json
database/init/schema.sql
deploy/traefik/{traefik.yml,traefik.prod.yml}
deploy/cloudflare/{README.md,real-ip.conf}
deploy/k8s/{README.md,namespace,configmap,secret.example,backend,frontend,ingress}.yaml
monitoring/{prometheus,alertmanager,grafana,loki,promtail}
docs/{production-hardening,observability,backup-restore,staging-deployment}.md
docs/screenshots/*.png
docker-compose.yml, docker-compose.staging.yml, docker-compose.prod.yml
```

---

## Roadmap

Implemented already: local bge-m3 embeddings, legislation ETL, active
inference queue, live SSE token streaming, optional Ansvar MCP Greek-law
retrieval with pgvector fallback, live Stripe billing + invoices,
email change, original document storage, OCR/vision images, scanned-PDF OCR,
message pagination, scheduled account deletion, PWA/SEO with build-time
`SITE_URL`, caching, feature flags, A/B experiments, optional Sentry,
observability, S3 backups, ZAP, edge rate limiting with Cloudflare real-IP
support, Kubernetes manifests and Stripe webhook registration.

Genuinely remaining / external:

- **Cloudflare account configuration** — WAF managed rules, account-side
  rate-limiting/cache rules, bot management and DDoS settings. The repository
  ships the origin-side rate limits and real-IP include only; the account
  controls cannot be configured in-repo.
- **Hosted Sentry DSN** — the SDKs are wired and no-op without a DSN; a
  hosted project/DSN is optional and external.
- **Vault/OpenBao** — file-based secrets and Kubernetes Secrets are supported;
  a secrets-manager integration is not shipped.

---

## License

Internal project — license TBD.
