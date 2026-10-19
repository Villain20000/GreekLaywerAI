# Observability, alerting, log aggregation and DAST

Operational guide for the NomosAI monitoring stack, edge/Cloudflare signals,
Sentry, offsite backups and the scheduled dynamic security scan. Backup/restore
procedures live in [backup-restore.md](backup-restore.md); deployment steps
live in [staging-deployment.md](staging-deployment.md). Edge hardening and
Kubernetes deployment are documented in
[production-hardening.md](production-hardening.md),
[`deploy/cloudflare/README.md`](../deploy/cloudflare/README.md) and
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Components

| Service | Image | Purpose | Exposure |
| --- | --- | --- | --- |
| `prometheus` | `prom/prometheus:v2.54.1` | Metrics, alert rules, Alertmanager target | internal `9090` |
| `alertmanager` | `prom/alertmanager:v0.27.0` | Groups/dedupes alerts, routes to Slack/email | internal `9093` |
| `grafana` | `grafana/grafana:11.2.0` | Dashboards, Prometheus + Loki datasources | loopback `127.0.0.1:3001` |
| `loki` | `grafana/loki:3.1.1` | Log store, filesystem, 7-day retention | internal `3100` |
| `promtail` | `grafana/promtail:3.1.1` | Tails Docker json-file logs, labels container/service | internal `9080` |
| `redis_exporter` | `oliver006/redis_exporter:v1.66.0` | `redis_up` and Redis metrics | internal `9121` |
| `node_exporter` | `prom/node-exporter:v1.8.2` | Host metrics + backup textfile | internal `9100` |

Everything except Grafana is internal to `nomosai-staging-network` /
`nomos-prod-network`. There is no public Prometheus, Loki or Alertmanager.

## Enable the monitoring profile

The stack is profile-gated so the application can run without it.

```bash
# Staging
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  --profile monitoring up -d

# Production (same images/config paths)
docker compose -f docker-compose.prod.yml --env-file .env.production \
  --profile monitoring up -d
```

Required for Grafana:

```dotenv
GRAFANA_ADMIN_PASSWORD=<long random value>
GRAFANA_PORT=3001          # optional, loopback only
```

Reach Grafana through an SSH tunnel:

```bash
ssh -N -L 3001:127.0.0.1:3001 deploy@staging-host
# http://127.0.0.1:3001
```

Prometheus data is kept 30 days; Loki data 7 days. Both use named volumes
(`prometheus_data_staging`, `loki_data_staging`); `docker compose down -v`
deletes history.

## Alert routing (Alertmanager)

Config: `monitoring/alertmanager/alertmanager.yml`, mounted read-only. The
Alertmanager v0.27 binary has no `--config.expand-env` flag, so the compose
entrypoint renders the `${VAR}` placeholders from the container environment
into `/tmp/alertmanager/alertmanager.yml` (with `awk`, so values are inserted
literally) before starting Alertmanager. The checked-in file therefore stays
env-driven and never contains secrets.

Rules (`monitoring/prometheus/alerts.yml`) carry `severity: critical` or
`severity: warning`. Critical alerts repeat hourly and inhibit the matching
warning (`alertname` + `instance`); warnings repeat every 4 hours. Everything
else goes to the default `nomos-alerts` receiver.

### Slack

1. Create an incoming webhook for the alerts channel.
2. Add to `.env.staging` / `.env.production` (never commit it):

   ```dotenv
   SLACK_WEBHOOK_URL=REPLACE_WITH_SLACK_INCOMING_WEBHOOK_URL
   SLACK_CHANNEL=#nomosai-alerts   # optional; webhook default otherwise
   ```

3. Recreate the container so the environment is applied:

   ```bash
   docker compose -f docker-compose.staging.yml --env-file .env.staging \
     --profile monitoring up -d alertmanager
   ```

### Email

Email reuses the stack's SMTP settings. Alertmanager supports STARTTLS
(usually port 587), not implicit TLS (465); use Slack for 465-only providers.

```dotenv
ALERT_EMAIL_TO=ops@example.com
ALERT_EMAIL_FROM=nomosai-alerts@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_REQUIRE_TLS=true
```

### Defaults and disabled delivery

The entrypoint and compose supply safe defaults so the config always parses,
even with no webhook and no mailbox:

- `SLACK_WEBHOOK_URL` defaults to `http://127.0.0.1:9/disabled`.
- `ALERT_EMAIL_TO` defaults to `alerts@localhost`; SMTP defaults to
  `localhost:25` with no auth.

In that state Alertmanager starts and dashboards still work, but each
notification attempt fails (logged in `docker compose logs alertmanager`).
Configure at least one channel in any environment that is expected to page.

### Verify and exercise

```bash
# Health
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  --profile monitoring exec alertmanager \
  wget -qO- http://127.0.0.1:9093/-/healthy

# Active alerts / silences
docker compose ... exec alertmanager amtool alert query
docker compose ... exec alertmanager amtool silence query

# Fire a synthetic alert (delivery path test)
docker compose ... exec alertmanager \
  amtool alert add NomosAITest severity=warning \
  --annotation=summary="Alert routing test"

# Silence a known noisy alert for 2h
docker compose ... exec alertmanager \
  amtool silence add alertname=DiskSpaceLow --duration=2h --comment="maintenance"
```

Rule changes require `curl -X POST http://alertmanager:9093/-/reload` from
inside the network (or restart the container). The stack does not enable
Prometheus' lifecycle endpoint, so restart `prometheus` after editing
`prometheus.yml` or `alerts.yml`.

## Logs (Loki + Promtail)

Promtail discovers containers through the read-only Docker socket and tails
their json-file logs from `/var/lib/docker/containers`. Labels added:

- `container` – Docker container name
- `service` – `com.docker.compose.service` (e.g. `backend`, `db`)
- `stream` – `stdout` or `stderr`

The Grafana datasource `Loki` (uid `loki`) is provisioned alongside
`Prometheus`; Prometheus remains the default. Use **Explore → Loki**:

```logql
{service="backend"}
{service="backend"} |= "error"
{service="backend"} | json | level="error"
{service=~"backend|frontend"} |= "500"
sum by (service) (rate({service=~".+"}[5m]))
```

Notes:

- Backend logs are pino JSON, so `| json` exposes `level`, `msg`, etc.
- Only the Docker `json-file` logging driver is collected. Changing the
  driver silently removes that container from Loki.
- Retention is 7 days (`limits_config.retention_period: 168h`, compactor
  enabled). Loki is for operations, not audit/compliance retention.
- `docker compose logs` remains the fastest path for a single container;
  Loki is for cross-service search and post-incident timelines.
- Loki/Promtail add disk and I/O load on the host. Watch
  `node_filesystem_avail_bytes`; the `DiskSpaceLow` alert covers it.

## Alert rules

`monitoring/prometheus/alerts.yml` covers:

- `BackendDown`, `High5xxRate`, `InferenceQueueBackedUp`
- `RedisDown`, `DiskSpaceLow`
- `BackupStale`, `BackupMetricMissing`
- `AlertmanagerDown`
- `TLSCertificateExpiringSoon` (dormant until a
  `probe_ssl_earliest_cert_expiry` series exists; see external monitoring)

Prometheus scrapes Alertmanager's `/metrics`; `AlertmanagerDown` fires if the
notification path itself breaks.

## Error and trace reporting (Sentry)

Sentry is optional and disabled by default. Both SDKs initialize only when a
DSN is present; without one they make no network calls and cannot fail boot.

Backend (`@sentry/node`, initialized in `src/config/sentry.js`):

```dotenv
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
SENTRY_ENVIRONMENT=production      # defaults to NODE_ENV
SENTRY_TRACES_SAMPLE_RATE=0        # clamped 0..1
```

Frontend (`@sentry/browser`, `src/main.ts`): `sentryDsn` and
`sentryTracesSampleRate` are compile-time values in
`frontend/src/environments/environment.prod.ts`, so enabling or changing them
requires rebuilding the SPA. Both SDKs set `sendDefaultPii: false`; keep
document/conversation content out of error metadata.

Sentry complements Prometheus/Loki: it carries stack traces and release
context, while Prometheus covers rates/latency and Loki covers logs.

## Edge and Kubernetes signals

- Traefik edge rate limiting (`EDGE_RATE_LIMIT_AVERAGE/BURST`,
  `EDGE_INFLIGHT_REQ_AMOUNT`) returns 429 at the proxy. Those requests never
  reach the backend, so they do not appear in `nomos_http_requests_total`;
  use Traefik access logs or Cloudflare analytics for edge-side counts.
  Backend rate limits and quotas do reach the app and are visible in the HTTP
  metrics by status code.
- Cloudflare WAF/rate-limit/cache actions live in the Cloudflare dashboard's
  Security Events/Analytics. They are account-side controls and are not
  scraped by this Prometheus stack.
- Frontend canonical/OG/sitemap URLs are baked at build time from `SITE_URL`;
  changing the public origin needs a frontend rebuild (see
  [production-hardening.md](production-hardening.md#deploy-time-site-url)),
  not a runtime configuration change.
- In Kubernetes, `/health` and `/metrics` are exposed by the backend
  Service. The checked-in Prometheus config scrapes Compose DNS names, so add
  a ServiceMonitor/PodMonitor (Prometheus Operator) or scrape annotations for
  the cluster. `/health` is also the readiness endpoint; see
  [`deploy/k8s/README.md`](../deploy/k8s/README.md).

## Offsite backups (S3)

`backend/src/scripts/backupDb.js` keeps the local dump + prune behaviour and
adds an optional S3 upload. The upload runs **after** the local dump and
**before** pruning and the Prometheus textfile. If it fails:

- the process exits non-zero (cron logs the failure),
- the local dump is kept for retry (nothing is pruned),
- `nomos_backup_last_success_timestamp_seconds` is not advanced, so
  `BackupStale` fires.

Enable it by setting `BACKUP_S3_BUCKET` on the `backup` sidecar:

```dotenv
BACKUP_S3_BUCKET=nomosai-backups
S3_REGION=eu-central-1
S3_PREFIX=nomosai/            # default
# S3_ENDPOINT=https://minio.example.com:9000   # MinIO/R2/B2/custom
# S3_FORCE_PATH_STYLE=true                     # MinIO
# S3_SSE=AES256                                # or aws:kms
# S3_ACCESS_KEY_ID=...
# S3_SECRET_ACCESS_KEY=...
```

- Without `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` the SDK uses the default
  AWS credential chain (`AWS_ACCESS_KEY_ID`, shared config, instance/task
  role). Static keys are optional.
- Object keys are `<prefix>/<dump filename>`, e.g.
  `nomosai/nomos_2026-10-19T02-00-00-000Z.dump`. Prefixes are normalized;
  `.`/`..` segments are stripped.
- Credentials are never logged. Only the bucket/key are printed.
- The backup sidecar mounts `./backend` from the host, so `backend/node_modules`
  must exist (`cd backend && npm ci`) for the upload to work. Alternatively
  run the script inside the backend image.
- A bucket policy scoped to the prefix is enough:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::nomosai-backups/nomosai/*"
    }]
  }
  ```

  Add `kms:GenerateDataKey` when using SSE-KMS, and consider bucket versioning,
  Object Lock and cross-region replication for ransomware/region resilience.

### Verify

```bash
# Local dumps and the freshness metric
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  exec backup sh -c 'ls -lht /backups/*.dump | head; cat /prom-textfile/nomos_backup.prom'

# Offsite objects
aws s3 ls "s3://${BACKUP_S3_BUCKET}/${S3_PREFIX:-nomosai/}" --recursive | tail

# One-off run (does not wait for the 02:00 cron)
docker compose ... exec backup sh -c 'cd /app/backend && node src/scripts/backupDb.js'
```

Download and restore an offsite dump with the procedure in
[backup-restore.md](backup-restore.md) (copy it into the `backups` volume or
the host backup directory first). Test a restore periodically; an upload that
has never been restored is not a verified backup.

## DAST (ZAP baseline)

Workflow: `.github/workflows/zap.yml`. It runs weekly (Mondays 04:17 UTC) and
on manual dispatch; it does **not** run on pull requests because staging may
be unavailable or mid-deploy.

Setup:

```bash
gh secret set STAGING_BASE_URL --body "https://staging.example.com"
gh workflow run zap.yml                                  # use the secret
gh workflow run zap.yml -f target_url=https://other.example.com
```

- Scans the public staging URL with `zaproxy/action-baseline` (spider +
  passive rules, no destructive active attacks).
- `fail_action: true` with `cmd_options: '-I'`: ZAP `FAIL`-level findings
  fail the job; `WARN`-level findings are reported but do not fail it.
- The HTML report is uploaded as the `zap-baseline-html` artifact (30 days);
  the action also uploads its own `zap-baseline-report` artifact.
- A missing `STAGING_BASE_URL` or an unreachable staging host fails loudly.
  That is intentional: a green DAST run must mean a scan actually happened.
- Baseline scans are unauthenticated. Authenticated flows (document upload,
  billing, admin) need a scripted/full scan with a dedicated test account;
  treat that as a follow-up before a production launch.

## Recommended external services

The self-hosted stack cannot alert when the host, network or Docker daemon is
down (the alert path dies with the thing it monitors). Add an external layer:

1. **Synthetic uptime / "Sentinel" monitor** – an off-host service
   (UptimeRobot, Better Stack, Pingdom, Grafana Cloud Synthetic Monitoring)
   probing `https://<domain>/healthz` and `https://<domain>/api/health` every
   1–5 minutes, alerting to the same Slack channel. This is the only check
   that survives a full host outage. It also covers TLS expiry and DNS.
2. **Error/trace APM** – Sentry is wired for backend and frontend and is
   inert without a DSN. Provide a hosted project/DSN via environment
   (backend) and build-time constants (frontend); see
   [Error and trace reporting](#error-and-trace-reporting-sentry). An
   OpenTelemetry-compatible backend remains an alternative but is not wired.
3. **Certificate expiry** – either let the external synthetic monitor check
   it, or add a `blackbox_exporter` TLS probe and point it at the public
   hostname. The `TLSCertificateExpiringSoon` rule activates automatically
   once `probe_ssl_earliest_cert_expiry` exists.
4. **Long-term log/audit retention** – Loki keeps 7 days. If compliance needs
   more, ship logs to S3 (Loki object storage) or a managed log service; do
   not rely on the local disk.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No Slack/email alerts | `docker compose logs alertmanager`; webhook/mailbox env; `amtool alert query`; `AlertmanagerDown` |
| Alertmanager exits at startup | Env placeholders expanded to invalid values; check logs and required email vars |
| `BackupStale` after enabling S3 | Upload failure in `docker compose logs backup`; local dump should still exist; check bucket policy/credentials/endpoint |
| Grafana has no logs | Loki healthy (`/ready`), Promtail logs, Docker socket/containers mounts, `{service="backend"}` query |
| `AlertmanagerDown` firing | `up{job="alertmanager"}` in Prometheus; container health; port 9093 on the compose network |
| ZAP job red | Read the artifact; a FAIL finding is a real issue; an unreachable host means staging is down |
