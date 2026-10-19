# Backup & disaster recovery runbook (3-3)

Operational guide for the NomosAI PostgreSQL backup and restore path.

- Backup script: `backend/src/scripts/backupDb.js`
- Restore script: `backend/src/scripts/restoreDb.js`
- npm alias: `cd backend && npm run restore -- --latest` (flags after `--`)

## What is backed up

`backupDb.js` runs `pg_dump -Fc` against the configured `DB_NAME` and writes a
PostgreSQL **custom-format** archive. That archive contains the database schema
and data for every NomosAI table, including:

- `users`, `subscriptions`, token and webhook-idempotency tables
- `conversations`, `messages`, `message_feedback`
- `legal_documents`, `legal_document_chunks`
- `legislation_embeddings` (pgvector data)
- `audit_log`, `usage_counters`

Not included:

- PostgreSQL roles/global objects (use `pg_dumpall --globals-only` separately if
  you need them).
- `.env`/secrets, TLS certificates, Ollama models, or Redis contents. Redis
  holds ephemeral queue/rate-limit state and is intentionally not restored.
- The backup volume itself is local storage. It should be replicated off-host
  (or snapshotted) as a separate operational control; this repository does not
  ship off-site copy configuration.

The target PostgreSQL server must have the `vector` (pgvector) extension
available; restoring into a stock Postgres without it fails.

## Schedule, filenames, and retention

The production compose `backup` sidecar installs `postgresql-client` and runs
the script daily at **02:00 container time** (UTC unless the container is given
a `TZ`):

```cron
0 2 * * * cd /app/backend && node src/scripts/backupDb.js
```

The `retention` sidecar is a different job (data retention, 03:00); it does not
delete backups.

Filename format (`backupDb.js`):

```text
nomos_<ISO-8601 UTC timestamp with ":" and "." replaced by "-">.dump
nomos_2026-10-19T02-00-00-000Z.dump
```

- `BACKUP_DIR` default: `backend/backups` (relative to the backend directory).
  Production compose sets `BACKUP_DIR=/backups`, backed by the
  `backups_prod` named volume.
- Retention is applied **only after a successful dump**: the oldest `.dump`
  files beyond the newest 14 are deleted. Override with
  `node src/scripts/backupDb.js --retain N`.
- 14 daily backups gives roughly two weeks of recovery points. A failed
  `pg_dump` never prunes or updates the freshness metric, so existing backups
  remain intact.

List backups:

```bash
ls -lht "$BACKUP_DIR"/*.dump | head
# production compose:
docker compose -f docker-compose.prod.yml exec backup sh -c 'ls -lht /backups/*.dump | head'
```

## Freshness metric and alerts

On success, `backupDb.js` atomically writes `nomos_backup.prom` into
`PROM_TEXTFILE_DIR` (shared with `node_exporter`'s textfile collector):

```text
nomos_backup_last_success_timestamp_seconds <unix seconds>
nomos_backup_last_duration_seconds <seconds>
```

Only a successful dump publishes the timestamp; a failed cron run leaves the
old value in place. Prometheus rules in `monitoring/prometheus/alerts.yml`:

- **BackupStale** — `time() - nomos_backup_last_success_timestamp_seconds > 48h`,
  `for: 10m`, severity critical. With a daily schedule this means at least one
  full daily run was missed (usually two).
- **BackupMetricMissing** — `absent(nomos_backup_last_success_timestamp_seconds)`
  for 6h, severity warning. The metric has never been scraped since Prometheus
  started: check the sidecar, the volume mount, and `PROM_TEXTFILE_DIR`.

Quick checks:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backup
docker compose -f docker-compose.prod.yml exec backup sh -c 'cat /prom-textfile/nomos_backup.prom'
# node_exporter is usually bound to 127.0.0.1:9100:
curl -fsS http://127.0.0.1:9100/metrics | grep '^nomos_backup_'
```

A stale or missing backup metric is a P1 operational issue. Fix the cron path,
credentials, disk space, or `PROM_TEXTFILE_DIR` before the next scheduled run.
The metric proves a dump was written, **not** that it can be restored — that is
what the quarterly drill is for.

## Restore CLI

```bash
cd backend

# Newest backup in BACKUP_DIR -> fresh timestamped scratch database
node src/scripts/restoreDb.js --latest

# Explicit file -> explicit scratch database
node src/scripts/restoreDb.js \
  --file backups/nomos_2026-10-19T02-00-00-000Z.dump \
  --target nomos_db_restore_manual

# npm alias (note the -- separator for flags)
npm run restore -- --latest
```

Flags:

| Flag | Meaning |
|---|---|
| `--file <path>` | Backup to restore (`.dump` custom or `.sql` plain). |
| `--latest` | Pick the newest `.dump`/`.sql` in `BACKUP_DIR` by mtime. |
| `--target <dbname>` | Target database. Default: `nomos_db_restore_<YYYYMMDD_HHMMSS>` (UTC). |
| `--allow-overwrite` | Permit restoring into an existing database. Requires `--yes`. |
| `--yes` | Non-interactive confirmation for `--allow-overwrite`. |
| `--help` | Usage text. |

Behavior:

- **Format detection** — `.dump`/`.pgdump` uses
  `pg_restore --clean --if-exists --no-owner --no-acl -d <target> <file>`;
  `.sql` uses `psql -v ON_ERROR_STOP=1 -f <file>` against the target. Unknown
  extensions are sniffed for the `PGDMP` custom-archive magic; non-text binary
  files are rejected.
- **Pre-flight** — file must exist and be non-empty; `psql` and `pg_restore`
  must be on `PATH`; the target database is looked up. A missing target is
  created automatically (this is how the timestamped scratch database works).
- **Safety** — restoring into the configured live `DB_NAME` is refused unless
  **both** `--allow-overwrite` and `--yes` are passed. Restoring into any other
  existing database also requires both flags. The resolved target and a
  warning are printed before the restore starts.
- **Sanity check** — after restoring, connects to the target and reports row
  counts for `users`, `conversations`, `messages`, `legal_documents`, and
  `legislation_embeddings`. Missing tables or a connection failure fail the run.
- **Passwords** — never placed in argv or logs. `DB_PASSWORD` is passed to
  child tools via the `PGPASSWORD` environment variable and redacted from
  error output.
- **Exit codes** — `0` on success; non-zero (`1`) on any pre-flight, restore,
  or sanity-check failure. The script uses `execFile` with argument arrays only;
  no shell interpolation.

Example successful output:

```text
[RESTORE] Backup: /backups/nomos_2026-10-19T02-00-00-000Z.dump (custom, 42.1 MiB)
[RESTORE] Target database: nomos_db_restore_20261019_120000 on db:5432
[RESTORE] WARNING: restore uses --clean --if-exists; existing objects in the target are replaced.
[RESTORE] Running: pg_restore -h db -p 5432 -U nomos_admin --clean --if-exists --no-owner --no-acl -d nomos_db_restore_20261019_120000 /backups/...
[RESTORE] Sanity counts: users=42 conversations=310 messages=1802 legal_documents=17 legislation_embeddings=9124
[RESTORE] Restore complete: /backups/... -> nomos_db_restore_20261019_120000
```

## Restore drill (quarterly)

Use staging or a disposable PostgreSQL instance for the drill. If the only
available copy of the backups is the production volume, copy the chosen backup
to the drill host rather than restoring over production.

### 1. Pick and inspect the backup

```bash
ls -lht "$BACKUP_DIR"/*.dump | head
# Note filename, size, and mtime as drill evidence.
```

### 2. Restore into a scratch database

```bash
cd backend
node src/scripts/restoreDb.js --latest
# Record the printed scratch target name.
```

This creates `nomos_db_restore_<YYYYMMDD_HHMMSS>` on the configured server. It
does **not** touch the live database. If the backup server is the production
server, make sure there is enough free disk for a second copy of the database.

### 3. Verify sanity counts

Copy the printed counts into the drill record. Compare them with the source
database or the previous drill. A count of zero can be legitimate on a fresh
deployment, but unexpected zeros for `users` or `legal_documents` warrant
investigation before declaring success.

```bash
psql -h "$DB_HOST" -U "$DB_USER" -d nomos_db_restore_<stamp> \
  -c 'SELECT count(*) FROM users;' \
  -c 'SELECT count(*) FROM legal_documents;' \
  -c 'SELECT count(*) FROM legislation_embeddings;'
```

### 4. Run migrations for older dumps (P0-8)

The restore script restores only what was in the dump. If the dump predates the
current application schema, the new backend will fail on missing tables or
columns.

**Always run `npm run migrate` before starting the new backend after restoring
an older dump.** The runner is idempotent (`migrate-all.js`):

```bash
cd backend
DB_NAME=nomos_db_restore_<stamp> npm run migrate
```

During an incident where the scratch DB has already been renamed to `nomos_db`,
run `npm run migrate` against `nomos_db` after the rename and before starting
the backend. Do not start writers against an un-migrated restored database.

If the restore's sanity check failed with `relation ... does not exist`, the
dump predates the current schema. That is intentional: the CLI treats missing
core tables as a failure. Run `npm run migrate` against the restored database,
then re-run the count queries in step 3 before promoting it.

### 5. Promote / swap (incident procedure)

Preferred: **rename swap**, which keeps the old database available for
rollback. Stop writers first.

```bash
# Stop everything that writes to the database or takes backups.
docker compose -f docker-compose.prod.yml stop backend retention backup

# Take a fresh backup of the current live DB first, if it is still reachable.
# (Run the normal backup command; do not skip this rollback point.)

# Terminate remaining sessions against both databases.
psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
   WHERE datname IN ('nomos_db', 'nomos_db_restore_<stamp>');"

# Keep the old DB as a rollback point, then promote the restored copy.
psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c \
  'ALTER DATABASE "nomos_db" RENAME TO "nomos_db_pre_restore_<YYYYMMDD>";'
psql -h "$DB_HOST" -U "$DB_USER" -d postgres -c \
  'ALTER DATABASE "nomos_db_restore_<stamp>" RENAME TO "nomos_db";'
```

Alternative: restore directly into live. Use this only with writers stopped and
a verified fresh backup in hand:

```bash
node src/scripts/restoreDb.js \
  --file backups/nomos_<timestamp>.dump \
  --target nomos_db \
  --allow-overwrite \
  --yes
```

Both flags are required. `pg_restore --clean --if-exists` drops and recreates
objects in the live database. There is no automatic rollback.

After promoting, run migrations (step 4) and restart the writers:

```bash
cd backend && npm run migrate
docker compose -f docker-compose.prod.yml up -d backend retention backup
```

Keep `nomos_db_pre_restore_<date>` until the restored database has passed
verification and a soak period. Drop it only after taking a validated backup of
the promoted database.

### 6. Post-restore verification

- `curl -fsS http://localhost:3000/health` → database/Redis/queue/Ollama blocks
  healthy (HTTP 200).
- `curl -fsS http://localhost:3000/api/ai/health` → inference queue healthy.
- **Login** with a known account; password hashes are restored from the dump.
  Verify the user lands on the workspace and `/api/auth/me` succeeds.
- **Documents** — upload a small PDF/DOCX/TXT, wait for processing, and search
  it. Check `SELECT count(*) FROM legal_documents;` and
  `SELECT count(*) FROM legal_document_chunks;` against the source.
- **Legislation** — check `SELECT count(*) FROM legislation_embeddings;` and
  run a RAG/legislation query.
- **Conversations** — open a restored conversation and confirm messages and
  feedback render.
- **Queue** — submit an AI query and confirm it reaches `completed`; confirm
  queue depth/dashboards are normal.
- **Billing** — verify a subscription row and `/api/subscriptions` respond
  (Stripe itself is external and is not restored).

If any check fails, stop writers and roll back by renaming the old database back
to `nomos_db` (terminate connections first).

### 7. Clean up scratch databases

After sign-off, remove the drill scratch database, or the retained
pre-restore database once the soak period ends:

```bash
psql -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'nomos_db_restore_<stamp>';"
psql -d postgres -c 'DROP DATABASE "nomos_db_restore_<stamp>";'
```

Never drop `nomos_db_pre_restore_*` until the promoted database is verified and
a new backup exists.

## Quarterly drill checklist and evidence

Record the following for every drill (attach to the ops ticket):

- [ ] Drill date and operator.
- [ ] Backup filename, size, mtime, and source (`BACKUP_DIR`/volume).
- [ ] Restore target name and PostgreSQL host/version.
- [ ] `restoreDb.js` exit code and full sanity output.
- [ ] `npm run migrate` result (required for older dumps).
- [ ] Application smoke checks: login, document count, legislation count, AI
      queue.
- [ ] **RTO** — wall-clock time from starting the restore to the application
      passing verification. Note whether this included the DB rename/restart.
- [ ] Issues encountered and follow-up actions.
- [ ] Cleanup completed (scratch DB dropped, old DB retained/dropped).

Evidence table template:

| Field | Value |
|---|---|
| Drill date / operator | 2026-10-19 / on-call name |
| Backup | `nomos_2026-10-19T02-00-00-000Z.dump`, 42.1 MiB |
| Source / target | `backups_prod` → `nomos_db_restore_20261019_120000` |
| Sanity counts | users=… conversations=… messages=… legal_documents=… legislation_embeddings=… |
| Migration | `npm run migrate` — OK / N migrations applied |
| Smoke | login OK; documents OK; legislation OK; queue OK |
| RTO | 18 min restore + verification |
| Follow-ups | e.g. restore client version mismatch |

## Troubleshooting

| Symptom | Check |
|---|---|
| `BackupStale` | `docker compose logs backup`; cron line in the sidecar; DB credentials; disk space; `PROM_TEXTFILE_DIR` mount. |
| `BackupMetricMissing` | `ls` the textfile dir and confirm node_exporter scrapes it; the metric is absent rather than old. |
| `Required command not available: psql/pg_restore` | Install `postgresql-client` in the container/host running the restore. |
| `could not execute query: ERROR: extension "vector" is not available` | Install pgvector on the target server (compose DB image includes it). |
| `unsupported version ... in file header` | Restore client is older than the `pg_dump` that produced the archive; use a matching/newer `postgresql-client`. |
| `database "..." already exists` | Choose a new `--target`, or pass both `--allow-overwrite` and `--yes` for a deliberate replacement. |
| `database "..." is being accessed by other users` | Stop writers and terminate sessions before `ALTER DATABASE ... RENAME`. |
| restore fails on permissions/ownership | The script already uses `--no-owner --no-acl`; ensure the restore role can create schemas/objects in the target. |
| password authentication failure | Check `DB_PASSWORD`; the script does not print it and redacts it from errors. |
| disk full during restore | Free space or restore to another server; the scratch copy is a full second copy of the DB. |
