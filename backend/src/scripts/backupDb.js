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

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || '5432';
const DB_USER = process.env.DB_USER || 'nomos_admin';
const DB_NAME = process.env.DB_NAME || 'nomos_db';

function parseRetain(argv) {
  const idx = argv.indexOf('--retain');
  if (idx === -1) return 14;
  const n = Number.parseInt(argv[idx + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 14;
}

function runPgDump(destPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-h', DB_HOST,
      '-p', DB_PORT,
      '-U', DB_USER,
      '-d', DB_NAME,
      '-Fc',
      '-f', destPath
    ];
    execFile('pg_dump', args, { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`pg_dump failed: ${stderr || err.message}`));
      resolve();
    });
  });
}

function pruneOldBackups(retain) {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.dump'))
      .map((f) => path.join(BACKUP_DIR, f))
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

(async () => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destPath = path.join(BACKUP_DIR, `nomos_${stamp}.dump`);
    await runPgDump(destPath);
    console.log(`[BACKUP] Dump written: ${destPath}`);
    pruneOldBackups(parseRetain(process.argv.slice(2)));
    process.exit(0);
  } catch (err) {
    console.error('[BACKUP] Backup failed:', err.message);
    process.exit(1);
  }
})();
