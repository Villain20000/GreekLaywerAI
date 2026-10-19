# Staging deployment, TLS, and secrets (3-2)

Runbook for the production-like NomosAI staging stack:

- Compose file: `docker-compose.staging.yml`
- Environment template: `.env.staging.example`
- Reverse proxy: `deploy/traefik/traefik.yml` (Traefik v3)
- Backend regression test: `backend/tests/stagingConfig.test.js`

Staging intentionally runs with `NODE_ENV=production` so production boot
guards (JWT secret, SMTP transport, CORS/APP_BASE_URL wiring) are exercised
before a release. It is **not** a sandbox for real user data: use throwaway
accounts, Stripe test mode, and a sandbox SMTP provider.

## Architecture

```
Internet :80/:443
        │
        ▼
   ┌─────────┐   HTTP (internal only)   ┌────────────────────┐
   │ Traefik │ ───────────────────────▶ │ frontend (nginx)   │
   │  v3     │  Host(STAGING_DOMAIN)    │ SPA + /api/ proxy  │
   └─────────┘                          └─────────┬──────────┘
        │ ACME HTTP-01 on :80                     │ /api/
        │ certs in traefik_certs volume           ▼
        │                                ┌────────────────────┐
        │                                │ backend :3000      │
        │                                └───┬───────┬────────┘
        │                                    │       │
        │                              ┌─────▼─┐  ┌──▼────┐
        │                              │  db   │  │ redis │
        │                              └───────┘  └───────┘
        │                              ollama / whisper sidecars
        └── optional monitoring profile (internal) ──────────
```

### Why Traefik v3 instead of nginx + certbot

For a single-host staging deploy, Traefik is one container and one static
config file:

- Docker label discovery means the public route lives next to the frontend
  service; there is no nginx template rendering or reload step.
- ACME issuance/renewal is built in (HTTP-01), so there is no certbot cron
  container, deploy hook, or shared webroot to keep in sync.
- HTTP→HTTPS redirect and health checking are first-class options.

The alternative (nginx + certbot) needs a second long-running unit plus a
renewal hook that reloads nginx, which is more moving parts for the same
single-host result. If the deployment ever moves to Kubernetes or needs
non-HTTP routing, revisit the proxy choice.

### Published ports

Only Traefik publishes host ports. The backend and data stores are reachable
**only** on the internal `nomos-staging-network`; the frontend's nginx proxies
`/api/` to `backend:3000`, so there is no direct backend exposure.

| Service | Container port | Host publication | Notes |
|---|---|---|---|
| `traefik` | 80, 443 | `${STAGING_HTTP_PORT:-80}`, `${STAGING_HTTPS_PORT:-443}` | The only public entrypoint; also `:8080` internal `/ping` |
| `frontend` | 80 | none | nginx SPA + `/api/` proxy |
| `backend` | 3000 | none | API, `/health`, `/metrics` internal |
| `db` | 5432 | none | PostgreSQL + pgvector |
| `redis` | 6379 | none | BullMQ/rate limits, AOF |
| `ollama` | 11434 | none | bge-m3 + gemma2b-mmap |
| `whisper` | 8000 | none | speaches/faster-whisper |
| `backup` | — | none | cron 02:00, writes `backups_staging` |
| `retention` | — | none | cron 03:00 |
| `prometheus` | 9090 | none | `--profile monitoring` |
| `grafana` | 3000 | `127.0.0.1:${GRAFANA_PORT:-3001}` | `--profile monitoring`, loopback only |
| `redis_exporter` | 9121 | none | `--profile monitoring` |
| `node_exporter` | 9100 | none | `--profile monitoring` |

Named volumes: `pgdata_staging`, `redisdata_staging`,
`ollama_models_staging`, `whisper_cache_staging`, `traefik_certs`,
`backups_staging`, `prometheus_data_staging`, `grafana_data_staging`,
`prom_textfile_staging`.

## Prerequisites

1. A Linux host with Docker Engine + Compose v2 and enough disk for Ollama
   models (several GB) and database backups.
2. DNS: an **A record** (and AAAA if you publish IPv6) for
   `STAGING_DOMAIN` pointing at the host. Wrong/extra AAAA records are a
   common cause of failed ACME challenges.
3. Inbound TCP **80 and 443** reachable from the internet. HTTP-01 uses
   port 80; if you override `STAGING_HTTP_PORT`, the public side must still
   map 80 → that port or ACME will fail.
4. No other process bound to 80/443 on the host.
5. A sandbox SMTP provider. Staging must not send to real users; use
   Mailtrap/Mailpit/MailHog or a provider's sandbox mode.
6. Stripe **test-mode** keys, or `STRIPE_SECRET_KEY=sk_test_mock` for the
   built-in mock checkout.

## First deploy

```bash
cd /opt/nomosai   # repository root

cp .env.staging.example .env.staging
chmod 600 .env.staging
# Keep the real file out of `git status`/accidental commits. The repository
# .gitignore only lists `.env`, so add a machine-local exclusion:
echo '.env.staging' >> .git/info/exclude

$EDITOR .env.staging       # replace every REPLACE_ME / example value

# Validate interpolation and YAML without printing resolved secret values.
docker compose -f docker-compose.staging.yml --env-file .env.staging config -q

# First boot: bring up dependencies, migrate, then start the app and proxy.
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  up -d --build db redis ollama whisper
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  run --rm backend npm run migrate
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  up -d --build

docker compose -f docker-compose.staging.yml --env-file .env.staging ps
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  exec backend npm run migrate      # idempotent; safe on every upgrade
```

`database/init/schema.sql` only runs when the Postgres volume is first
created. Existing staging volumes are upgraded with `npm run migrate`, which
runs every idempotent migration in `backend/src/scripts/migrate-all.js`.

Wait for `ollama` to download `bge-m3` + `gemma2b-mmap` on first boot; the
backend's `depends_on` waits for its healthcheck (up to ~10 minutes on slow
links). `docker compose ps` should show `(healthy)` for `db`, `redis`,
`ollama`, `backend`, `frontend` and `traefik`.

## Environment reference

Compose interpolation happens on the host. Values marked **required** cause
`docker compose config`/`up` to fail if missing.

| Variable | Required | Purpose |
|---|---|---|
| `STAGING_DOMAIN` | yes | Public hostname; ACL/Traefik `Host()` rule and `APP_BASE_URL`/`CORS_ORIGINS` |
| `ACME_EMAIL` | yes | Let's Encrypt account/expiry contact |
| `STAGING_ACME_CA` | no | ACME directory URL; defaults to the **staging** CA |
| `STAGING_HTTP_PORT` / `STAGING_HTTPS_PORT` | no | Host ports, default 80/443 |
| `DB_PASSWORD` | yes | PostgreSQL password (backend, backup, retention, db) |
| `JWT_SECRET` | yes | JWT signing key; production guard rejects unset/default |
| `EMAIL_FROM` | yes | From header; production SMTP boot guard |
| `SMTP_HOST` | yes | Sandbox SMTP host; production boot guard |
| `SMTP_PORT` | no | Default 587 |
| `SMTP_SECURE` | no | `true` for implicit TLS (usually port 465) |
| `SMTP_USER` / `SMTP_PASS` | no | Leave empty for an unauthenticated relay |
| `STRIPE_SECRET_KEY` | yes | `sk_test_...` or `sk_test_mock`; never `sk_live_` |
| `STRIPE_PRICE_ID_BASIC/PRO/ENTERPRISE` | no* | *Required for real test-mode Checkout |
| `STRIPE_WEBHOOK_SECRET` | no* | *Required for real webhook signature verification |
| `GRAFANA_ADMIN_PASSWORD` | yes | Compose requires it even when the profile is off; used by `grafana` |
| `RETENTION_CONVERSATIONS_DAYS` / `RETENTION_DOCUMENTS_DAYS` / `RETENTION_AUDIT_LOG_DAYS` | no | Defaults 365/365/90 |
| `WHISPER_MODEL` / `WHISPER_TIMEOUT_MS` | no | Must match the sidecar's `PRELOAD_MODELS` |
| `LOG_LEVEL` | no | pino level, default `info` |
| `SCRAPED_LAWS_PATH` | no | Host path to scraper JSON; must exist before boot |
| `STAGING_BACKEND_IMAGE` / `STAGING_FRONTEND_IMAGE` | no | Registry image tags for reproducible deploys/rollback |
| `GRAFANA_PORT` | no | Loopback port for Grafana, default 3001 |

`NODE_ENV=production`, `EMAIL_TRANSPORT=smtp`, `TRUST_PROXY=uniquelocal,loopback`,
`APP_BASE_URL=https://${STAGING_DOMAIN}`, `CORS_ORIGINS=https://${STAGING_DOMAIN}`,
and the Ollama/Whisper/Redis hostnames are set directly in the compose file.

### Stripe webhooks

With `sk_test_mock`, checkout is simulated and no webhook is needed. With a
real test key, Stripe must reach a **public HTTPS URL**:

```
https://${STAGING_DOMAIN}/api/billing/webhook
```

Add that endpoint in the Stripe Dashboard (test mode) or forward with the
Stripe CLI, then put its signing secret in `STRIPE_WEBHOOK_SECRET`. The path
is mounted before the JSON body parser so raw-body signature verification
works. Rotating the secret requires updating both sides.

## TLS and ACME

### Staging CA by default

`STAGING_ACME_CA` defaults to:

```
https://acme-staging-v02.api.letsencrypt.org/directory
```

Staging certificates are **not trusted** by browsers or `curl`; that is
expected. They have much higher rate limits and cannot burn the production
Let's Encrypt quota. Verify with:

```bash
curl -kI "https://${STAGING_DOMAIN}/"
curl -k "https://${STAGING_DOMAIN}/api/ai/health"
```

### Switching to the production CA

Once DNS/ports are stable and you need a publicly trusted cert:

```bash
# 1. Update .env.staging:
#    STAGING_ACME_CA=https://acme-v02.api.letsencrypt.org/directory
# 2. Remove the old resolver state so Traefik re-registers with the new CA.
docker compose -f docker-compose.staging.yml --env-file .env.staging stop traefik
docker run --rm -v nomosai-staging_traefik_certs:/letsencrypt alpine \
  rm -f /letsencrypt/acme.json
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d traefik
```

Check the volume name with `docker volume ls` if your Compose project name
differs. Do not delete `acme.json` while Traefik is running.

### Renewal and storage

- Certificates/account state live in the `traefik_certs` named volume at
  `/letsencrypt/acme.json` (mode `0600`).
- Renewal is **automatic**: Traefik checks and renews certificates before
  expiry, with no host cron or certbot timer. Back up the volume only if you
  need to preserve the account; losing it simply triggers re-issuance.
- HTTP (`:80`) redirects to HTTPS via the `web → websecure` entrypoint
  redirect in `deploy/traefik/traefik.yml`. The ACME HTTP-01 challenge is
  handled on `:80` before the redirect.
- HSTS is intentionally commented out in the frontend labels until TLS is
  validated. With the staging CA, enabling HSTS can pin browsers to an
  untrusted certificate. After switching to the production CA and confirming
  the chain, uncomment the `nomos-staging-hsts` labels in
  `docker-compose.staging.yml`.

### Self-signed / localhost fallback

For a host with no public DNS (or to test the routing locally), Traefik can
serve its built-in self-signed certificate:

1. Set `STAGING_DOMAIN=localhost` in `.env.staging`.
2. In `docker-compose.staging.yml`, comment out the label
   `traefik.http.routers.nomos-staging.tls.certresolver=le` on the
   `frontend` service.
3. Optionally comment the five `--certificatesresolvers.le.acme.*` flags on
   `traefik` to stop ACME attempts (they only run when a router names the
   resolver, but the logs are cleaner).
4. `docker compose ... up -d --force-recreate frontend traefik`, then open
   `https://localhost/` and accept the browser warning.

For a locally trusted cert, generate one with `mkcert`, mount the files into
Traefik, and add a file-provider TLS store (`tls.certificates` /
`tls.stores.default.defaultCertificate`). That override is intentionally not
shipped: staging should normally use ACME.

### ACME troubleshooting

- `404`/timeout on `/.well-known/acme-challenge/...`: DNS does not point at
  the host, port 80 is blocked, or another process owns port 80.
- Certificate exists but the browser says "not trusted": expected on the
  staging CA. Confirm the issuer with
  `openssl s_client -connect "$STAGING_DOMAIN:443" -servername "$STAGING_DOMAIN" </dev/null | openssl x509 -noout -issuer`.
- Rate-limit errors: stay on the staging CA while iterating; only switch
  after DNS and ports are stable.
- `traefik` logs show `acme.json` permission errors: remove the volume and
  let Traefik recreate it.

## Secrets management

### Minimum viable approach: `.env.staging`

The shipped path is a single env file read by Compose:

```bash
cp .env.staging.example .env.staging
chmod 600 .env.staging
echo '.env.staging' >> .git/info/exclude   # repo .gitignore only covers `.env`
```

Rules:

- Never commit `.env.staging`; the example file contains dummy placeholders
  only.
- `docker compose config` **prints resolved secrets** — always use `config -q`
  in scripts/logs.
- `docker inspect` and `/proc/<pid>/environ` expose env values to anyone with
  Docker/host access. Restrict host access accordingly.
- Back up secrets in a password manager, not in the repository or the
  `backups_staging` volume.

### Next step: Docker secrets (with an honest caveat)

Docker Compose `secrets:` mounts files under `/run/secrets/<name>` (this is a
bind mount, not encrypted at rest outside Swarm). The backend currently reads
**only environment variables** and does **not** implement `*_FILE` variables:
setting `JWT_SECRET_FILE` or `SMTP_PASS_FILE` does nothing today. To use
Docker secrets you must wrap startup and export the values into env, e.g.:

```yaml
services:
  backend:
    secrets:
      - jwt_secret
      - db_password
    entrypoint:
      - /bin/sh
      - -c
      - |
        export JWT_SECRET="$$(cat /run/secrets/jwt_secret)"
        export DB_PASSWORD="$$(cat /run/secrets/db_password)"
        exec npm start

secrets:
  jwt_secret:
    file: ./secrets/jwt_secret
  db_password:
    file: ./secrets/db_password
```

Create `secrets/` with mode `0700` and files with mode `0600`, and replace
the corresponding `environment:` entries (Compose lets the entrypoint's
exports coexist, but do not keep duplicate plaintext values in the file).

This still exposes the values as process env (and therefore to
`docker inspect`); it mainly removes them from the compose file and shell
history. True `_FILE` support requires a small entrypoint in the backend image
that reads the files before `node src/index.js`; that is not implemented in
this repository. Vault/OpenBao integration is a further stretch goal and is
also not shipped.

### Rotation

| Secret | Steps | Actual session/impact behavior |
|---|---|---|
| `JWT_SECRET` | Generate `openssl rand -hex 64`, update `.env.staging`, `up -d --force-recreate backend` | **All existing JWTs become invalid immediately** (signature check fails). Users must log in again. `users.token_version` is unrelated and unchanged. |
| Per-user token invalidation | Password change/reset or email verification | Backend bumps `users.token_version` atomically; old tokens for that user are rejected while other users stay logged in. This is not a secret rotation, but it is the correct lever for one-account revocation. |
| `STRIPE_WEBHOOK_SECRET` | Create/roll the endpoint secret in Stripe, update `.env.staging`, restart backend | Events signed with the old secret fail until Stripe retries with the new one. Roll during low traffic; verify a test event returns 200. |
| `STRIPE_SECRET_KEY` / price IDs | Update to new test key/price, restart backend | No user sessions affected. Existing test subscriptions keep their stored price IDs. |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_HOST` | Update sandbox credentials, restart backend | No sessions affected. Send a forgot-password request and confirm delivery in the sandbox inbox. |
| `DB_PASSWORD` | `ALTER USER nomos_admin WITH PASSWORD '...'` inside `db`, update `.env.staging`, `up -d --force-recreate backend backup retention db` | Open connections survive until the containers restart; expect a short outage. Run in a maintenance window and verify `backup` can still dump. |
| `GRAFANA_ADMIN_PASSWORD` | Update `.env.staging`, `up -d --force-recreate grafana` | Grafana admin session only. |
| `ACME_EMAIL` | Update `.env.staging`, restart `traefik` | Existing certificates remain valid; only future ACME account/expiry notices use the new address. |

Use `docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --force-recreate <service>`
after env changes; a plain `restart` does not re-read the env file.

## Upgrade and rollback

### Upgrade

```bash
cd /opt/nomosai
git fetch --tags
git checkout <release-tag>
docker compose -f docker-compose.staging.yml --env-file .env.staging build
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  exec backend npm run migrate
```

Migrations are additive and idempotent; run them after the new backend image
starts. Single-host staging has a brief restart gap — that is acceptable.

### Rollback

Application-only rollback (preferred):

```bash
# Pin the previous release images in .env.staging:
#   STAGING_BACKEND_IMAGE=registry.example.com/nomosai/backend:<prev>
#   STAGING_FRONTEND_IMAGE=registry.example.com/nomosai/frontend:<prev>
docker compose -f docker-compose.staging.yml --env-file .env.staging pull
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  up -d --no-build backend frontend
```

Pin immutable tags (or digests) in the registry for every release; `latest`
or `:local` tags cannot be rolled back reliably. If you build on the host,
retag the previous build before upgrading (`docker tag ...:<old>`).

Database rollback: migrations are forward-only. If a release is not
compatible with the migrated schema, restore the pre-upgrade dump using the
procedure in [`docs/backup-restore.md`](backup-restore.md), then run
`npm run migrate` on the restored database before starting the old image.
Do not restore over the live database without both `--allow-overwrite` and
`--yes`.

## Backup and restore

The staging stack mirrors production's cron sidecars:

- `backup` runs `backend/src/scripts/backupDb.js` at 02:00 into the
  `backups_staging` volume (`/backups`), retaining 14 dumps.
- `retention` runs `backend/src/scripts/retentionCleanup.js` at 03:00
  (conversations by `updated_at`; documents/audit by `created_at`).
- Backup freshness is published to `prom_textfile_staging` for the
  `BackupStale` alert when the monitoring profile is enabled.

Staging is the intended place for the quarterly restore drill. Follow
[`docs/backup-restore.md`](backup-restore.md) in full; the short version:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  exec backup sh -c 'ls -lht /backups/*.dump | head'
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  exec backup node src/scripts/restoreDb.js --latest
```

The restore script creates a timestamped scratch database and runs sanity
counts; run `npm run migrate` against older dumps before starting a new
backend. Backups are **not** replicated off-host by this repository — add a
host snapshot/rclone job if staging data must survive host loss.

## Smoke checklist

Run after the first deploy and after every upgrade:

1. **Containers healthy** —
   `docker compose ... ps` shows healthy core services; `docker compose ...
   logs --tail=100 traefik backend` has no crash loop or ACME errors.
2. **TLS/redirect** — `curl -kI "http://${STAGING_DOMAIN}/"` returns a 301/308
   to `https://`; `curl -kI "https://${STAGING_DOMAIN}/"` returns 200 and the
   SPA loads. With the staging CA the browser warning is expected.
3. **API health** — `curl -k "https://${STAGING_DOMAIN}/api/ai/health"`
   returns 200. `/health` is internal-only; use
   `docker compose ... exec backend node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"`
   if needed.
4. **Register → verify → login** — create a throwaway account. The
   verification link arrives in the sandbox SMTP inbox (or check
   `docker compose ... logs backend` for send failures). Verify, log in.
5. **Ask the AI** — submit a question in `/chat`; the job queues, Ollama
   warms up, and an answer with sources appears. First request is slow.
6. **Upload/search** — upload a small PDF/DOCX (≤25 MB) under `/documents`;
   confirm it appears and search returns it.
7. **Billing** — with `sk_test_mock`, use mock checkout and confirm the tier
   changes. With real test keys, use card `4242 4242 4242 4242`, confirm
   Checkout returns to `/chat?checkout=success`, and send a test webhook to
   `https://${STAGING_DOMAIN}/api/billing/webhook` (expect 200, duplicate
   delivery is idempotent). Check `GET /api/subscriptions`.
8. **GDPR** — export data and delete the throwaway account from `/profile`;
   confirm the second attempt is rejected (stale token) and no other user's
   data is touched.
9. **Backups** — `docker compose ... exec backup sh -c 'ls -lht /backups | head'`
   shows a recent dump; optionally run the restore drill above.
10. **Monitoring (if enabled)** — `curl -fsS http://127.0.0.1:3001/api/health`
    through an SSH tunnel, and check Prometheus targets are UP.

## Optional monitoring

The staging stack reuses `monitoring/` unchanged under a profile, so the
production dashboards/alerts are exercised without duplicating config:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  --profile monitoring up -d
```

- `prometheus` and both exporters publish no host ports.
- `grafana` binds `127.0.0.1:${GRAFANA_PORT:-3001}` only. Reach it with
  `ssh -L 3001:127.0.0.1:3001 user@staging-host` and open
  `http://localhost:3001`.
- Scrape targets are `backend:3000`, `redis_exporter:9121`, and
  `node_exporter:9100` on the internal network.
- Alert rules live in `monitoring/prometheus/alerts.yml`; no external
  Alertmanager is wired up.

## Troubleshooting quick reference

| Symptom | Check |
|---|---|
| Traefik returns 404 for the domain | `docker compose ... logs traefik`; frontend is on `nomos-staging-network`; label rule uses the exact `STAGING_DOMAIN`; `traefik.docker.network` matches |
| ACME challenge fails | A/AAAA DNS, inbound 80, no other listener on 80, CAA allows Let's Encrypt; stay on the staging CA while iterating |
| Backend restarts immediately | `docker compose ... logs backend` — usually missing `JWT_SECRET`, `SMTP_HOST`, or `EMAIL_FROM`; production guards fail closed |
| 502 from the SPA/API | `backend` unhealthy or still starting; `docker compose ... ps`, then backend logs |
| Rate limits hit the wrong IP | Keep `TRUST_PROXY=uniquelocal,loopback`; add a hop/count only if another proxy is introduced |
| Ollama never healthy | Host RAM/disk; watch `docker compose ... logs -f ollama` while models download |
| Emails never arrive | Sandbox credentials, spam folder, backend logs; SMTP failures are logged and retried |
| `config` prints secrets in CI logs | Use `docker compose ... config -q`; never `config` without `-q` on real env files |
| Cert trusted in browser but not CLI | Staging CA is not in the system trust store; use `curl -k` or install the staging root only for testing |
