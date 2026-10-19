#!/usr/bin/env node
// 3-3: PostgreSQL restore CLI (backup & disaster recovery).
//
// Usage:
//   node src/scripts/restoreDb.js --file backups/nomos_2026-10-19T02-00-00-000Z.dump
//   node src/scripts/restoreDb.js --latest
//   node src/scripts/restoreDb.js --file dump.sql --target nomos_db_restore_test
//   node src/scripts/restoreDb.js --file dump.dump --target nomos_db \
//     --allow-overwrite --yes
//
// Without --target the restore goes into a fresh scratch database named
// nomos_db_restore_<YYYYMMDD_HHMMSS> (UTC). A missing scratch database is
// created automatically. Restoring into ANY existing database requires both
// --allow-overwrite and --yes; restoring into the configured live DB_NAME is
// refused without both flags (and should only be done with writers stopped,
// after taking a fresh backup).
//
// Format detection:
//   .dump / custom pg_dump archive  -> pg_restore --clean --if-exists ...
//   .sql / plain SQL               -> psql -v ON_ERROR_STOP=1 -f ...
//   unknown extension              -> PGDMP magic sniff, otherwise plain text
//
// After the restore the script connects to the target and prints row counts
// for the core tables. Any pre-flight, restore, or sanity failure exits 1.
//
// No passwords are ever placed in argv or logs. PGPASSWORD is passed through
// the child process environment only, and DB_PASSWORD is redacted from errors.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { getSecret } = require('../config/secrets');

const SANITY_TABLES = Object.freeze([
  'users',
  'conversations',
  'messages',
  'legal_documents',
  'legislation_embeddings'
]);

const USAGE = `Usage:
  node src/scripts/restoreDb.js --latest [--target <dbname>]
  node src/scripts/restoreDb.js --file <path> [--target <dbname>]

Options:
  --file <path>        Backup file to restore (.dump custom or .sql plain)
  --latest             Use the newest .dump/.sql in BACKUP_DIR
  --target <dbname>    Target database (default: nomos_db_restore_<YYYYMMDD_HHMMSS>)
  --allow-overwrite    Allow restoring into an existing database (requires --yes)
  --yes                Non-interactive confirmation for --allow-overwrite
  --help               Show this help

Environment: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, BACKUP_DIR.
Exit codes: 0 success; 1 pre-flight, restore, or sanity-check failure.`;

function getConfig() {
  return {
    backupDir: process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'),
    host: process.env.DB_HOST || 'localhost',
    port: String(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'nomos_admin',
    password: getSecret('DB_PASSWORD', ''),
    dbName: process.env.DB_NAME || 'nomos_db'
  };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** Default scratch target: nomos_db_restore_<YYYYMMDD_HHMMSS> in UTC. */
function defaultTargetName(now = new Date()) {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `_${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
  return `nomos_db_restore_${stamp}`;
}

function validateTargetName(target) {
  // Strict identifier allow-list keeps the name safe in both argv and the
  // single SQL identifier we have to interpolate for CREATE DATABASE.
  if (typeof target !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(target)) {
    throw new Error(
      `Invalid target database name "${target}". ` +
      'Use letters, digits and underscores, starting with a letter or underscore (max 63 chars).'
    );
  }
  if (['postgres', 'template0', 'template1'].includes(target)) {
    throw new Error(`Refusing to restore into PostgreSQL maintenance database "${target}".`);
  }
  return target;
}

function parseArgs(argv = []) {
  const opts = {
    file: null,
    latest: false,
    target: null,
    allowOverwrite: false,
    yes: false,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--target') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value. Run with --help for usage.`);
      }
      opts[arg.slice(2)] = value;
    } else if (arg === '--latest') {
      opts.latest = true;
    } else if (arg === '--allow-overwrite') {
      opts.allowOverwrite = true;
    } else if (arg === '--yes') {
      opts.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}. Run with --help for usage.`);
    }
  }

  if (opts.help) return opts;
  if (opts.file && opts.latest) {
    throw new Error('Use either --file or --latest, not both.');
  }
  if (!opts.file && !opts.latest) {
    throw new Error('A backup source is required: pass --file <path> or --latest. Run with --help for usage.');
  }
  return opts;
}

function findLatestBackup(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new Error(`Cannot read BACKUP_DIR "${dir}": ${err.message}`);
  }

  const files = entries
    .filter((name) => /\.(dump|sql)$/i.test(name))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return stat.isFile() ? { path: fullPath, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));

  if (files.length === 0) {
    throw new Error(`No .dump or .sql backups found in "${dir}".`);
  }
  return files[0].path;
}

function inspectBackupFile(file) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_err) {
    throw new Error(`Backup file not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Backup path is not a regular file: ${resolved}`);
  }
  if (stat.size === 0) {
    throw new Error(`Backup file is empty: ${resolved}`);
  }
  return { path: resolved, size: stat.size };
}

/**
 * Prefer the extension; for unknown extensions sniff the pg_dump custom
 * archive magic ("PGDMP"). Binary files that are neither custom archives nor
 * plain text are rejected instead of being fed to psql.
 */
function detectFormat(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.dump' || ext === '.pgdump') return 'custom';
  if (ext === '.sql') return 'plain';

  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(512);
  let bytes = 0;
  try {
    bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (bytes >= 5 && buffer.subarray(0, 5).toString('ascii') === 'PGDMP') {
    return 'custom';
  }
  if (buffer.subarray(0, bytes).includes(0)) {
    throw new Error(
      `Unsupported binary backup format in ${file}. ` +
      'Expected a pg_dump custom archive (.dump) or plain SQL (.sql).'
    );
  }
  return 'plain';
}

function connectionArgs(config) {
  return ['-h', config.host, '-p', config.port, '-U', config.user];
}

function commandEnv(config) {
  return { PGPASSWORD: config.password };
}

function buildPgRestoreArgs(config, target, file) {
  return [
    ...connectionArgs(config),
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    '-d', target,
    file
  ];
}

function buildPsqlRestoreArgs(config, target, file) {
  return [
    ...connectionArgs(config),
    '-d', target,
    '-v', 'ON_ERROR_STOP=1',
    '-f', file
  ];
}

function buildSanityQuery() {
  return SANITY_TABLES.map((table, index) => {
    const select = index === 0 ? 'SELECT' : 'UNION ALL SELECT';
    return `${select} '${table}' AS table_name, COUNT(*)::bigint AS row_count FROM ${table}`;
  }).join('\n');
}

function redactSecrets(value, secrets = []) {
  let output = String(value === undefined || value === null ? '' : value);
  for (const secret of secrets) {
    if (secret) output = output.split(String(secret)).join('***');
  }
  return output;
}

function formatCommand(command, args) {
  const rendered = args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg));
  return [command, ...rendered].join(' ');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function runCommand(command, args, { env = {}, secrets = [] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = redactSecrets((stderr || err.message || '').trim(), secrets);
          return reject(
            new Error(`${command} failed${detail ? `: ${detail}` : ''}`)
          );
        }
        // Keep stdout verbatim (it carries psql catalog answers such as "1");
        // stderr is redacted because client tools echo server errors there.
        resolve({
          stdout: stdout || '',
          stderr: redactSecrets(stderr || '', secrets)
        });
      }
    );
  });
}

async function assertCommand(command, secrets) {
  try {
    await runCommand(command, ['--version'], { secrets });
  } catch (_err) {
    throw new Error(
      `Required command not available: ${command}. Install the PostgreSQL client tools (postgresql-client).`
    );
  }
}

async function targetDatabaseExists(config, target) {
  // target is validated as a strict SQL identifier, so embedding it in this
  // catalog lookup cannot inject SQL.
  const sql = `SELECT 1 FROM pg_database WHERE datname = '${target}'`;
  const { stdout } = await runCommand(
    'psql',
    [...connectionArgs(config), '-d', 'postgres', '-tAc', sql],
    { env: commandEnv(config), secrets: [config.password] }
  );
  return stdout.trim() === '1';
}

async function createTargetDatabase(config, target) {
  const sql = `CREATE DATABASE "${target}"`;
  await runCommand(
    'psql',
    [...connectionArgs(config), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { env: commandEnv(config), secrets: [config.password] }
  );
}

async function runSanityCheck(config, target) {
  const client = new Client({
    host: config.host,
    port: Number(config.port),
    user: config.user,
    password: config.password || undefined,
    database: target,
    connectionTimeoutMillis: 10000
  });

  const counts = {};
  try {
    await client.connect();
    const result = await client.query(buildSanityQuery());
    const byTable = new Map(result.rows.map((row) => [row.table_name, row.row_count]));

    for (const table of SANITY_TABLES) {
      if (!byTable.has(table)) {
        throw new Error(`sanity query did not return a count for ${table}`);
      }
      const count = Number(byTable.get(table));
      if (!Number.isFinite(count)) {
        throw new Error(`sanity query returned an invalid count for ${table}`);
      }
      counts[table] = count;
    }
  } finally {
    try {
      await client.end();
    } catch (_err) {
      // Never mask the original connect/query failure with a close error.
    }
  }
  return counts;
}

function log(message) {
  console.log(`[RESTORE] ${message}`);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return { help: true };
  }

  const config = getConfig();
  const target = validateTargetName(opts.target || defaultTargetName());
  const isLive = target === config.dbName;
  const overwriteConfirmed = opts.allowOverwrite && opts.yes;

  // Safety gate first: refuse the live database before touching the file or
  // spawning any command.
  if (isLive && !overwriteConfirmed) {
    throw new Error(
      `Refusing to restore into the configured live database "${target}" ` +
      'without both --allow-overwrite and --yes. Restore into a scratch ' +
      'database first (omit --target to use the timestamped default).'
    );
  }

  const fileInfo = opts.file
    ? inspectBackupFile(opts.file)
    : inspectBackupFile(findLatestBackup(config.backupDir));
  const format = detectFormat(fileInfo.path);

  log(`Backup: ${fileInfo.path} (${format}, ${formatBytes(fileInfo.size)})`);
  log(`Target database: ${target} on ${config.host}:${config.port}`);
  if (isLive) {
    log(
      'WARNING: target is the configured live DB_NAME. Writers MUST be stopped. ' +
      'This restore will DROP/REPLACE objects in the live database.'
    );
  } else {
    log('WARNING: restore uses --clean --if-exists; existing objects in the target are replaced.');
  }

  const secrets = [config.password];
  await assertCommand('psql', secrets);
  await assertCommand('pg_restore', secrets);

  const exists = await targetDatabaseExists(config, target);
  if (exists && !overwriteConfirmed) {
    throw new Error(
      `Target database "${target}" already exists. Re-run with ` +
      '--allow-overwrite AND --yes to replace its objects, or choose a new --target.'
    );
  }
  if (!exists) {
    log(`Target database "${target}" does not exist; creating it.`);
    await createTargetDatabase(config, target);
  }

  if (format === 'custom') {
    const args = buildPgRestoreArgs(config, target, fileInfo.path);
    log(`Running: ${formatCommand('pg_restore', args)}`);
    await runCommand('pg_restore', args, {
      env: commandEnv(config),
      secrets
    });
  } else {
    const args = buildPsqlRestoreArgs(config, target, fileInfo.path);
    log(`Running: ${formatCommand('psql', args)}`);
    await runCommand('psql', args, {
      env: commandEnv(config),
      secrets
    });
  }

  let counts;
  try {
    counts = await runSanityCheck(config, target);
  } catch (err) {
    throw new Error(
      `Post-restore sanity check failed for "${target}": ` +
      redactSecrets(err.message, secrets)
    );
  }

  log(
    `Sanity counts: ${SANITY_TABLES.map((table) => `${table}=${counts[table]}`).join(' ')}`
  );

  return {
    file: fileInfo.path,
    format,
    target,
    created: !exists,
    counts
  };
}

if (require.main === module) {
  main().then(
    (result) => {
      if (result && !result.help) {
        console.log(`[RESTORE] Restore complete: ${result.file} -> ${result.target}`);
      }
      process.exit(0);
    },
    (err) => {
      console.error(
        `[RESTORE] ${redactSecrets(err.message, [getSecret('DB_PASSWORD', '')])}`
      );
      process.exit(1);
    }
  );
}

module.exports = {
  SANITY_TABLES,
  buildPgRestoreArgs,
  buildPsqlRestoreArgs,
  buildSanityQuery,
  defaultTargetName,
  detectFormat,
  findLatestBackup,
  main,
  parseArgs,
  validateTargetName
};
