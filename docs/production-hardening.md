# Production hardening

This runbook covers the production edge (TLS, rate limiting, Cloudflare),
secrets from files, Redis response caching, feature flags, optional Sentry,
build-time site URLs and the legislation mock-corpus guard. It complements
`docs/staging-deployment.md` (staging runbook), `docs/backup-restore.md`
(backup/restore), [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md)
(account-side WAF/CDN/cache) and [`deploy/k8s/README.md`](../deploy/k8s/README.md)
(multi-host baseline).

## Stack and deploy

`docker-compose.prod.yml` runs the same application services as staging with
production defaults:

- Traefik v3.7 terminates TLS (Let's Encrypt **production** ACME directory by
  default) and is the only container publishing public ports (`80`/`443`).
- The frontend nginx container is the only Traefik route; it serves the SPA
  and proxies `/api/` to `backend:3000`, so the API, PostgreSQL, Redis, Ollama
  and whisper are never reachable from the host.
- PostgreSQL, Redis, Ollama (GPU reservation), whisper, backup/retention
  cron sidecars, and the optional monitoring profile (Prometheus,
  Alertmanager, Loki, Promtail, Grafana, exporters) stay on the internal
  `nomos-prod-network`.
- Grafana's loopback-only port (`127.0.0.1:${GRAFANA_PORT:-3001}`) is the one
  non-Traefik host binding; reach it through an SSH tunnel.

A Kubernetes baseline for multi-host deployments lives in `deploy/k8s/`; it
uses external PostgreSQL/Redis/Ollama and the same frontend-nginx-to-backend
proxy pattern. The Compose stack remains the default.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# Replace every REPLACE_WITH_* value first.
docker compose -f docker-compose.prod.yml --env-file .env.production config -q
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production exec backend npm run migrate
# Optional observability:
docker compose -f docker-compose.prod.yml --env-file .env.production \
  --profile monitoring up -d
```

`config -q` validates the file without printing resolved secrets. Without
`-q`, Compose prints every value including passwords.

The compose project is named `nomosai-prod`. When upgrading an existing
stack that was created under the default (directory-derived) project name,
reuse the old project name with `-p <name>` or migrate the named volumes,
otherwise Compose creates a fresh set of empty volumes.

## TLS at the edge

- `deploy/traefik/traefik.prod.yml` is the static Traefik config (Docker
  provider, HTTP→HTTPS redirect, header-alias hardening, internal `/ping`).
- ACME flags live in `docker-compose.prod.yml`. `DOMAIN`, `ACME_EMAIL` and
  the optional `PROD_ACME_CA` (default
  `https://acme-v02.api.letsencrypt.org/directory`) control issuance.
  Certificates persist in the `traefik_certs_prod` volume.
- Before the first boot, create an A (and AAAA if used) DNS record for
  `DOMAIN` pointing at the host. TCP 80 and 443 must be reachable for the
  HTTP-01 challenge and normal traffic.
- The HTTP router on the frontend redirects to HTTPS via the
  `nomos-prod-redirect` middleware; the `web` entrypoint also redirects
  globally as defense in depth.
- HSTS is not enabled by default. Once the certificate path is proven valid
  for the final domain, add these labels to the `frontend` service and attach
  the middleware to the `nomos-prod` router:

  ```yaml
  - "traefik.http.middlewares.nomos-prod-hsts.headers.stsSeconds=31536000"
  - "traefik.http.middlewares.nomos-prod-hsts.headers.stsIncludeSubdomains=true"
  - "traefik.http.middlewares.nomos-prod-hsts.headers.stsPreload=true"
  - "traefik.http.routers.nomos-prod.middlewares=nomos-prod-hsts"
  ```

- With a Cloudflare proxy in front (orange cloud), HTTP-01 is intercepted by
  Cloudflare. Either point the record at the origin (DNS-only) during
  issuance, use a DNS-01 challenge, or terminate TLS at Cloudflare with an
  Origin CA certificate and set SSL mode to Full (strict). Keep the origin
  reachable only from Cloudflare IP ranges. See
  [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md) for the
  account-side WAF/CDN/cache setup; the application still enforces its own
  per-user/IP rate limits and daily quotas.

## Edge rate limiting

The public HTTPS router carries two Traefik middleware:

- `ratelimit` — `EDGE_RATE_LIMIT_AVERAGE` requests/second (default 50) with a
  burst of `EDGE_RATE_LIMIT_BURST` (default 100);
- `inflightreq` — at most `EDGE_INFLIGHT_REQ_AMOUNT` concurrent requests
  (default 100).

Compose interpolates the labels, so changing a value requires recreating the
frontend container (`up -d --force-recreate frontend`). The limits are
per-request: a long-lived SSE response consumes one request slot, not one slot
per event, so live AI streaming keeps working. Traefik's limiter keys on the
connection peer; behind Cloudflare that is a Cloudflare edge IP unless you
configure trusted forwarded headers or `IPStrategy`. The backend's per-user
limits and daily quotas remain the authoritative per-account controls.

Tune the values for your load before enabling a Cloudflare account-side
rate-limiting rule; do not set both so low that normal SPA asset loads trip
them.

## Cloudflare real client IP

`deploy/cloudflare/real-ip.conf` holds the current Cloudflare IPv4/IPv6
ranges plus `real_ip_header CF-Connecting-IP` and `real_ip_recursive on`. The
Compose stacks mount it read-only at
`/etc/nginx/cloudflare/real-ip.conf`; `frontend/nginx.conf` wildcard-includes
that directory (plain `docker run` deployments must mount the same file).
Direct traffic is unaffected because nginx only honors the header when the
immediate peer is a configured `set_real_ip_from` range.

In the bundled chain (Cloudflare -> Traefik -> nginx) nginx's peer is Traefik.
To make the forwarded header effective, uncomment the private-range block in
`real-ip.conf` **and** restrict origin ingress to Cloudflare ranges, otherwise
clients could spoof `CF-Connecting-IP` through Traefik. Refresh the file from
`https://www.cloudflare.com/ips/` whenever Cloudflare publishes changes and
recreate the frontend container. Request/response caching, WAF managed rules
and DDoS settings are Cloudflare account controls; see
[`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md).

## Deploy-time site URL

`SITE_URL` is a frontend **build** argument (default
`https://your-domain.gr`). The image build runs `npm run build`, which chains
`ng build` and `frontend/scripts/apply-site-url.js`; the script replaces the
placeholder origin in `dist/nomos-ai-frontend/browser/index.html`,
`sitemap.xml` and `robots.txt`. Set it in `.env.production` / `.env.staging`
before `up --build`:

```dotenv
SITE_URL=https://app.example.com
```

The script fails if the Angular build output is missing or `SITE_URL` is not a
bare http(s) origin. Changing the domain requires rebuilding the frontend
image (the generated canonical/OG URLs are static).

## Optional Sentry

The backend (`@sentry/node`) and frontend (`@sentry/browser`) are wired but
inert without a DSN:

- backend: `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`) and
  `SENTRY_TRACES_SAMPLE_RATE` (clamped 0..1, default 0). No network calls and
  no boot failure when the DSN is empty or invalid.
- frontend: `sentryDsn` / `sentryTracesSampleRate` live in
  `frontend/src/environments/environment.prod.ts` and are baked in at build
  time; changing them requires a rebuild.
- Both initialize with `sendDefaultPii: false`. Do not attach document or
  conversation content to error reports.

## Stripe webhook registration

Register the endpoint with the API instead of clicking through the Dashboard:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec backend npm run stripe:webhook -- --dry-run
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec backend npm run stripe:webhook
```

The script reads `STRIPE_SECRET_KEY` (or its `_FILE`) and `APP_BASE_URL`,
matches `${APP_BASE_URL}/api/billing/webhook`, creates it with the six handled
event types when absent, or adds missing events to an existing endpoint.
Creation prints the signing secret **once**; store it as
`STRIPE_WEBHOOK_SECRET` (or its `_FILE`) and restart the backend. Existing
secrets are never retrievable through the API. The script fails non-zero on
errors and never logs the API key.

## Secrets from files

`backend/src/config/secrets.js` resolves secrets in this order:

1. `${NAME}_FILE` (path; read as UTF-8, trailing CR/LF stripped)
2. `process.env[NAME]`
3. the caller's fallback

A configured-but-unreadable file throws at load time. The first successful
file read also hydrates `process.env[NAME]`, so legacy modules that still
read the plain variable directly stay consistent in a file-only deployment.
Supported names:

| Secret | Where used |
| --- | --- |
| `DB_PASSWORD` | PostgreSQL pool (`DB_PASSWORD_FILE`) |
| `JWT_SECRET` | JWT signing/verification, production boot guard |
| `STRIPE_SECRET_KEY` | Stripe client / mock-mode detection |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `SMTP_USER`, `SMTP_PASS` | SMTP transport auth |

Docker (bind mount a host file that the container can read):

```yaml
services:
  backend:
    volumes:
      - /run/secrets/jwt_secret:/run/secrets/jwt_secret:ro
    environment:
      - JWT_SECRET_FILE=/run/secrets/jwt_secret
```

Make sure the plain `JWT_SECRET` still satisfies Compose interpolation (see
the note at the top of `.env.production.example`); the file always wins when
both are present. The PostgreSQL container itself continues to use
`POSTGRES_PASSWORD`; switch it to `POSTGRES_PASSWORD_FILE` manually if you
also want the database's own credential mounted.

Kubernetes:

```yaml
env:
  - name: JWT_SECRET_FILE
    value: /var/run/secrets/nomos/jwt
  - name: DB_PASSWORD_FILE
    value: /var/run/secrets/nomos/db_password
volumeMounts:
  - name: nomos-secrets
    mountPath: /var/run/secrets/nomos
    readOnly: true
```

Compose `secrets:` blocks are intentionally not declared: they require
pre-existing host files and would make `docker compose config` fail on a
fresh checkout. Use the `_FILE` convention with whatever mount mechanism
your platform provides.

## Redis response cache

`backend/src/services/cacheService.js` is a lazy ioredis client over
`REDIS_URL` with a `nomos:cache:` namespace (override with `CACHE_PREFIX`).
It is strictly fail-open: no Redis URL, a connection failure, or a timeout
returns a cache miss/false and logs once per error class. It never throws.

- `ragService.retrieveContext()` caches successful, non-empty legislation
  hits under `rag:context:<sha256(normalized query)>:<limit>` for
  `RAG_CACHE_TTL_SECONDS` (default 300). Only global legislation rows are
  cached; uploaded-document retrieval stays per-user and is never cached.
- `GET /api/billing/plans` caches the server-owned catalog under
  `billing:plans` for `PLANS_CACHE_TTL_SECONDS` (default 3600).
- Invalidate manually after a catalog deploy if you cannot wait for the TTL:

  ```bash
  docker compose -f docker-compose.prod.yml exec redis sh -c \
    "redis-cli --scan --pattern 'nomos:cache:*' | xargs -r redis-cli DEL"
  ```

Redis also backs the BullMQ queue, rate limiting and live SSE fan-out, so do
not flush the whole database in production.

## Feature flags

`GET /api/config` is public (no Bearer token) and returns
`{ "features": { ...booleans } }`. It is parsed from `FEATURE_FLAGS`:

- comma-separated tokens; whitespace and empty tokens are ignored;
- a bare name enables the flag;
- `name:false` (also `0`, `off`, `no`) disables it;
- unspecified known flags stay `true`; known names are case-insensitive and
  canonicalized (`admindocuments` → `adminDocuments`);
- unknown names are passed through, so a flag can ship in `FEATURE_FLAGS`
  before the frontend consumes it.

Defaults: `billing`, `documents`, `audio`, `adminDocuments` are all `true`.
Example: `FEATURE_FLAGS=documents:false,adminDocuments:false`.

Changing `FEATURE_FLAGS` requires a backend restart (no live reload). The
frontend `FeatureFlagsService` fetches `/api/config` once per app lifetime
without credentials and defaults every flag to enabled on any failure. The
menu hides Documents when `documents` is false, Billing/Subscriptions when
`billing` is false, and admin-documents when `adminDocuments` is false.
Chat and Profile stay visible.

## Legislation mock-corpus guard

`backend/src/scripts/ingestLegislation.js` refuses to silently index the
embedded 3-article demo corpus when `NODE_ENV=production`:

- a missing default `scraped_laws.json`, a malformed file, or a corpus that
  normalizes to zero rows aborts with a clear error;
- production ingests only the real scraped rows (mocks are not mixed in);
- `ALLOW_MOCK_CORPUS=true` is the explicit opt-in for demo environments;
- dev/test behavior is unchanged (fallback mocks still work).

Mount a real corpus at `SCRAPED_LAWS_PATH` and run
`docker compose ... exec backend node src/scripts/ingestLegislation.js`.

## Monitoring and logs

Enable with `--profile monitoring`. Prometheus is internal; Alertmanager,
Loki and Promtail are internal (Promtail reads the Docker socket and
`/var/lib/docker/containers`). Grafana stays loopback-only. Configure
Alertmanager receivers in `monitoring/alertmanager/alertmanager.yml` and
ship/retain logs according to your policy. Sentry is optional and no-ops
without a DSN; see [observability.md](observability.md#error-and-trace-reporting-sentry).

## Multi-host deployment (Kubernetes)

`deploy/k8s/` ships a baseline for the stateless application tier:

- 2+ backend and frontend replicas, readiness/liveness probes, resource
  requests/limits, non-root security contexts and rolling updates;
- a `backend` Service (so frontend nginx's `backend:3000` proxy resolves), a
  `frontend` Service and an ingress-nginx Ingress for the same
  domain/TLS assumptions;
- an HPA for the backend (2-6 pods) and external PostgreSQL+pgvector, Redis
  and Ollama endpoints configured through a ConfigMap and Secret.

It is not a full stateful stack and does not include backup/retention
CronJobs, NetworkPolicies or a ServiceMonitor. Build the frontend with
`--build-arg SITE_URL=https://...`, apply the manifests with `kubectl apply`,
run migrations from a backend pod, and keep using Compose for single-host
deployments. Full instructions:
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Remaining external responsibilities

These are deliberately outside this repository and must be provided by the
platform/operator:

- Cloudflare account configuration: DNS, proxying, WAF managed rules,
  rate-limiting rules, cache rules and DDoS/bot settings. The repository only
  ships Traefik/nginx rate limiting and the real-IP include; see
  [`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md).
- A hosted Sentry project/DSN if you want external error tracking. The SDKs
  are wired and inert without a DSN; the hosted service is not.
- A secret manager such as Vault/OpenBao and rotation schedules. File-based
  secrets are supported via `*_FILE` and Kubernetes Secrets; the manager
  itself is yours to run.
- S3 bucket lifecycle/versioning/replication policy and periodic restore
  drills. `BACKUP_S3_BUCKET` uploads each dump from `backupDb.js`; see
  [backup-restore.md](backup-restore.md).
- External SMTP deliverability (SPF/DKIM/DMARC).
- Certificate expiry monitoring, uptime checks, log retention beyond the
  shipped Loki retention, and additional security scanners beyond the weekly
  ZAP baseline.
