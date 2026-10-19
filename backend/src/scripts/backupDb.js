#!/usr/bin/env node
// Phase 29: PostgreSQL backup script.
//
// Usage:
//   node src/scripts/backupDb.js [--retain N]
//
// Dumps the NomosAI database with pg_dump (custom format) into the
// BACKUP_DIR (default ./backups) as nomos_<ISO-timestamp>.dump, then prunes
// the N oldest files (default 14). Wire to cron:
//   0 2 * * * cd /opt/nomosai/backend && node src/scripts/backupDb.js
//
// Offsite copy (optional): when BACKUP_S3_BUCKET is set the dump is uploaded
// to S3 after the local write, before pruning/metrics. A failed upload exits
// non-zero and leaves the local dump in place for a later retry. Credentials
// come from S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY or the AWS default chain;
// they are never logged.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
// 3-1: optional Prometheus textfile collector output. When set (prod compose
// points it at a volume shared with node_exporter), a successful backup
// publishes its completion timestamp so `BackupStale` can alert on silently
// broken cron jobs. Leave unset to keep the script's behaviour unchanged.
const PROM_TEXTFILE_DIR = process.env.PROM_TEXTFILE_DIR || '';
const DEFAULT_S3_PREFIX = 'nomosai/';

function parseRetain(argv) {
  const idx = argv.indexOf('--retain');
  if (idx === -1) return 14;
  const n = Number.parseInt(argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function runPgDump(destPath, env = process.env) {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', env.DB_HOST || 'localhost',
      '-p', env.DB_PORT || '5432',
      '-U', env.DB_USER || 'nomos_admin',
      '-d', env.DB_NAME || 'nomos_db',
      '-Fc',
      '-f', destPath
    ];
    execFile('pg_dump', args, { env: { ...process.env, PGPASSWORD: env.DB_PASSWORD || '' } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`pg_dump failed: ${stderr || err.message}`));
      resolve();
    });
  });
}

function pruneOldBackups(retain, backupDir = BACKUP_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(backupDir)
      .filter((f) => f.endsWith('.dump'))
      .map((f) => path.join(backupDir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch (err) {
    console.error('[BACKUP] Could not read backup dir:', err.message);
    return;
  }
  const excess = files.length - retain;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(files[i]);
      console.log(`[BACKUP] Pruned old backup: ${path.basename(files[i])}`);
    } catch (err) {
      console.error(`[BACKUP] Failed to prune ${files[i]}:`, err.message);
    }
  }
}

/**
 * Publish a Prometheus textfile for node_exporter's textfile collector.
 * Only called after a successful dump and (when configured) upload, so a
 * failed run leaves the previous timestamp in place and `BackupStale` fires
 * as intended. Never throws: observability must not fail a backup.
 */
function writeBackupMetric(startedAtMs, textfileDir = PROM_TEXTFILE_DIR) {
  if (!textfileDir) return;
  try {
    fs.mkdirSync(textfileDir, { recursive: true });
    const successSeconds = Math.floor(Date.now() / 1000);
    const durationSeconds = (Date.now() - startedAtMs) / 1000;
    const body = [
      '# HELP nomos_backup_last_success_timestamp_seconds Unix timestamp of the last successful pg_dump backup.',
      '# TYPE nomos_backup_last_success_timestamp_seconds gauge',
      `nomos_backup_last_success_timestamp_seconds ${successSeconds}`,
      '# HELP nomos_backup_last_duration_seconds Duration of the last successful pg_dump backup.',
      '# TYPE nomos_backup_last_duration_seconds gauge',
      `nomos_backup_last_duration_seconds ${durationSeconds.toFixed(3)}`,
      ''
    ].join('\n');
    const target = path.join(textfileDir, 'nomos_backup.prom');
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
    console.log(`[BACKUP] Wrote Prometheus textfile: ${target}`);
  } catch (err) {
    console.error('[BACKUP] Could not write Prometheus textfile:', err.message);
  }
}

function normalizeS3Prefix(prefix) {
  const raw = prefix == null ? '' : String(prefix);
  const segments = raw
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  return segments.length ? segments.join('/') : DEFAULT_S3_PREFIX.replace(/\/+$/, '');
}

/**
 * Build the S3 object key. Blank prefixes fall back to `nomosai/`; dots and
 * duplicate slashes are stripped so a misconfigured prefix cannot escape the
 * intended bucket namespace.
 */
function buildS3Key(prefix, filename) {
  const base = path.basename(String(filename || '').replace(/\\/g, '/'));
  if (!base || base === '.' || base === '..') {
    throw new Error('S3 upload requires a backup filename');
  }
  return `${normalizeS3Prefix(prefix)}/${base}`;
}

// Loaded lazily so local-only deployments never require the AWS SDK.
function loadS3Sdk() {
  // eslint-disable-next-line global-require
  return require('@aws-sdk/client-s3');
}

function isTruthy(value) {
  return value === '1' || String(value).toLowerCase() === 'true';
}

function createS3Client(env = process.env) {
  const { S3Client } = loadS3Sdk();
  const options = {
    region: env.S3_REGION || env.AWS_REGION || 'us-east-1'
  };
  if (env.S3_ENDPOINT) options.endpoint = env.S3_ENDPOINT;
  if (isTruthy(env.S3_FORCE_PATH_STYLE)) options.forcePathStyle = true;

  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (accessKeyId || secretAccessKey) {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set');
    }
    options.credentials = { accessKeyId, secretAccessKey };
  }
  return new S3Client(options);
}

/**
 * Upload one dump to S3. Returns the object key, or null when S3 is not
 * configured. Errors propagate so the CLI can exit non-zero without pruning
 * the local dump.
 */
async function uploadBackup({ filePath, env = process.env, client } = {}) {
  const bucket = env.BACKUP_S3_BUCKET;
  if (!bucket) return null;

  const { PutObjectCommand } = loadS3Sdk();
  const key = buildS3Key(env.S3_PREFIX, path.basename(filePath));
  const s3 = client || createS3Client(env);
  const body = fs.createReadStream(filePath);
  const params = {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream'
  };
  if (env.S3_SSE) params.ServerSideEncryption = env.S3_SSE;

  try {
    await s3.send(new PutObjectCommand(params));
  } catch (err) {
    body.destroy();
    throw err;
  }
  return key;
}

async function main({
  env = process.env,
  argv = process.argv.slice(2),
  runDump = runPgDump,
  upload = uploadBackup,
  prune = pruneOldBackups,
  writeMetric = writeBackupMetric
} = {}) {
  const startedAtMs = Date.now();
  const backupDir = env.BACKUP_DIR || BACKUP_DIR;

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = path.join(backupDir, `nomos_${stamp}.dump`);

  await runDump(destPath, env);
  console.log(`[BACKUP] Dump written: ${destPath}`);

  let uploadedKey = null;
  if (env.BACKUP_S3_BUCKET) {
    uploadedKey = await upload({ filePath: destPath, env });
    console.log(`[BACKUP] Uploaded to s3://${env.BACKUP_S3_BUCKET}/${uploadedKey}`);
  }

  prune(parseRetain(argv), backupDir);
  writeMetric(startedAtMs, env.PROM_TEXTFILE_DIR ?? PROM_TEXTFILE_DIR);
  return { destPath, uploadedKey };
}

async function runCli(options = {}) {
  try {
    const result = await main(options);
    return { exitCode: 0, result };
  } catch (err) {
    console.error('[BACKUP] Backup failed:', err.message);
    return { exitCode: 1, error: err };
  }
}

if (require.main === module) {
  runCli().then(({ exitCode }) => process.exit(exitCode));
}

module.exports = {
  buildS3Key,
  createS3Client,
  main,
  normalizeS3Prefix,
  parseRetain,
  pruneOldBackups,
  runCli,
  runPgDump,
  uploadBackup,
  writeBackupMetric
};
