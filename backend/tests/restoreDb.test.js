// 3-3: restoreDb CLI tests.
//
// Everything is mocked: child_process (no psql/pg_restore binaries) and pg
// (no database connection). Files are real temp files so the size/format
// pre-flight checks are exercised without touching PostgreSQL.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Client } = require('pg');

jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('pg', () => ({ Client: jest.fn() }));

const restore = require('../src/scripts/restoreDb');

const PASSWORD = 'sup3r-s3cret-pg-password';
const ENV_KEYS = ['BACKUP_DIR', 'DB_NAME', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD'];

let tmpDir;
let savedEnv;

function makeBackup(name, content = 'PGDMP fake custom archive') {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Install a fake execFile. All PostgreSQL binaries succeed by default;
 * `exists` controls the psql catalog lookup. `fail(command, args)` may return
 * a stderr string to force a failure for a specific invocation.
 */
function installRunner({ exists = false, fail = null } = {}) {
  const calls = [];

  execFile.mockImplementation((command, args, options, callback) => {
    calls.push({ command, args, options });

    const failure = fail && fail(command, args);
    if (failure) {
      return callback(new Error('command failed'), '', failure);
    }
    if (args.includes('--version')) {
      return callback(null, `${command} 16.4`, '');
    }
    if (command === 'psql' && args.includes('-tAc')) {
      return callback(null, exists ? '1\n' : '\n', '');
    }
    if (command === 'psql' && args.includes('-c')) {
      return callback(null, 'CREATE DATABASE\n', '');
    }
    return callback(null, '', '');
  });

  return calls;
}

function installClient(counts = {
  users: 12,
  conversations: 4,
  messages: 22,
  legal_documents: 3,
  legislation_embeddings: 500
}) {
  const query = jest.fn().mockResolvedValue({
    rows: Object.entries(counts).map(([table_name, row_count]) => ({
      table_name,
      row_count: String(row_count)
    }))
  });
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    end: jest.fn().mockResolvedValue(undefined)
  };
  Client.mockImplementation(() => client);
  return client;
}

function restoreCall(calls, command) {
  return calls.find(
    (call) => call.command === command && !call.args.includes('--version')
  );
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomos-restore-'));
  execFile.mockReset();
  Client.mockReset();

  process.env.BACKUP_DIR = tmpDir;
  process.env.DB_NAME = 'nomos_db';
  process.env.DB_HOST = 'db';
  process.env.DB_PORT = '5432';
  process.env.DB_USER = 'nomos_admin';
  process.env.DB_PASSWORD = PASSWORD;
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('restoreDb format detection and arguments', () => {
  it('restores a custom .dump through pg_restore with safe flags', async () => {
    const file = makeBackup('nomos_2026-10-19T02-00-00-000Z.dump');
    const calls = installRunner({ exists: false });
    const client = installClient();

    const result = await restore.main([
      '--file', file,
      '--target', 'nomos_db_restore_fixture'
    ]);

    const pgRestore = restoreCall(calls, 'pg_restore');
    expect(pgRestore).toBeDefined();
    expect(pgRestore.args).toEqual(expect.arrayContaining([
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '-d', 'nomos_db_restore_fixture',
      file
    ]));
    expect(pgRestore.options.env.PGPASSWORD).toBe(PASSWORD);

    expect(result).toMatchObject({
      file,
      format: 'custom',
      target: 'nomos_db_restore_fixture',
      created: true
    });
    expect(result.counts.users).toBe(12);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('creates a missing scratch target with psql CREATE DATABASE', async () => {
    const file = makeBackup('nomos_backup.dump');
    const calls = installRunner({ exists: false });
    installClient();

    await restore.main(['--file', file, '--target', 'nomos_db_restore_create']);

    const create = calls.find(
      (call) => call.command === 'psql' && call.args.includes('-c')
    );
    expect(create).toBeDefined();
    expect(create.args).toContain('CREATE DATABASE "nomos_db_restore_create"');
    expect(create.args).toEqual(expect.arrayContaining(['-d', 'postgres', '-v', 'ON_ERROR_STOP=1']));
  });

  it('restores plain .sql through psql with ON_ERROR_STOP', async () => {
    const file = makeBackup('nomos_backup.sql', '-- plain dump\nCREATE TABLE users (id int);\n');
    const calls = installRunner({ exists: false });
    installClient();

    const result = await restore.main([
      '--file', file,
      '--target', 'nomos_db_restore_plain'
    ]);

    const psqlRestore = calls.find(
      (call) => call.command === 'psql' && call.args.includes('-f')
    );
    expect(psqlRestore).toBeDefined();
    expect(psqlRestore.args).toEqual(expect.arrayContaining([
      '-v', 'ON_ERROR_STOP=1',
      '-f', file,
      '-d', 'nomos_db_restore_plain'
    ]));
    expect(restoreCall(calls, 'pg_restore')).toBeUndefined();
    expect(result.format).toBe('plain');
  });

  it('sniffs the PGDMP magic for extensionless backups', async () => {
    const file = makeBackup('nomos_backup_no_extension', 'PGDMP custom payload');
    const calls = installRunner({ exists: false });
    installClient();

    const result = await restore.main(['--file', file, '--target', 'nomos_db_restore_sniff']);

    expect(result.format).toBe('custom');
    expect(restoreCall(calls, 'pg_restore')).toBeDefined();
  });

  it('picks the newest .dump/.sql with --latest', async () => {
    const older = makeBackup('nomos_2026-01-01T00-00-00-000Z.dump');
    const newer = makeBackup('nomos_2026-02-01T00-00-00-000Z.dump');
    fs.utimesSync(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    fs.utimesSync(newer, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

    installRunner({ exists: false });
    installClient();

    const result = await restore.main(['--latest', '--target', 'nomos_db_restore_latest']);
    expect(result.file).toBe(newer);
  });
});

describe('restoreDb safety gates', () => {
  it('refuses the configured live DB without BOTH --allow-overwrite and --yes', async () => {
    process.env.DB_NAME = 'nomos_live';
    const file = makeBackup('nomos_live.dump');

    for (const flags of [[], ['--allow-overwrite'], ['--yes']]) {
      execFile.mockReset();
      await expect(
        restore.main(['--file', file, '--target', 'nomos_live', ...flags])
      ).rejects.toThrow(/Refusing to restore into the configured live database/);
      expect(execFile).not.toHaveBeenCalled();
    }
  });

  it('allows the live DB only with the two explicit flags and warns loudly', async () => {
    process.env.DB_NAME = 'nomos_live';
    const file = makeBackup('nomos_live.dump');
    const calls = installRunner({ exists: true });
    installClient();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const result = await restore.main([
      '--file', file,
      '--target', 'nomos_live',
      '--allow-overwrite',
      '--yes'
    ]);

    expect(result.target).toBe('nomos_live');
    expect(restoreCall(calls, 'pg_restore')).toBeDefined();
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(
      /WARNING: target is the configured live DB_NAME/
    );
  });

  it('refuses an existing non-live target without the overwrite confirmation', async () => {
    const file = makeBackup('nomos_existing.dump');
    const calls = installRunner({ exists: true });
    installClient();

    await expect(
      restore.main(['--file', file, '--target', 'nomos_existing'])
    ).rejects.toThrow(/already exists.*--allow-overwrite AND --yes/);
    expect(restoreCall(calls, 'pg_restore')).toBeUndefined();
  });

  it('uses a timestamped scratch target by default', async () => {
    const file = makeBackup('nomos_default_target.dump');
    const calls = installRunner({ exists: false });
    installClient();

    const result = await restore.main(['--file', file]);

    expect(result.target).toMatch(/^nomos_db_restore_\d{8}_\d{6}$/);
    expect(result.created).toBe(true);
    expect(restoreCall(calls, 'pg_restore').args).toEqual(
      expect.arrayContaining(['-d', result.target])
    );
  });

  it('formats the default target from UTC components', () => {
    expect(restore.defaultTargetName(new Date('2026-10-19T12:34:56Z'))).toBe(
      'nomos_db_restore_20261019_123456'
    );
  });
});

describe('restoreDb pre-flight failures', () => {
  it('rejects a missing file without spawning any command', async () => {
    await expect(
      restore.main(['--file', path.join(tmpDir, 'does-not-exist.dump')])
    ).rejects.toThrow(/Backup file not found/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects an empty file without spawning any command', async () => {
    const file = makeBackup('empty.dump', '');
    await expect(restore.main(['--file', file])).rejects.toThrow(/Backup file is empty/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('rejects --latest when BACKUP_DIR has no backups', async () => {
    await expect(restore.main(['--latest'])).rejects.toThrow(/No \.dump or \.sql backups found/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports missing PostgreSQL client tools before restoring', async () => {
    const file = makeBackup('nomos_tool_missing.dump');
    const calls = installRunner({
      exists: false,
      fail: (command, args) =>
        command === 'psql' && args.includes('--version') ? 'psql: not found' : null
    });
    installClient();

    await expect(
      restore.main(['--file', file, '--target', 'nomos_db_restore_tools'])
    ).rejects.toThrow(/Required command not available: psql/);
    expect(restoreCall(calls, 'psql')).toBeUndefined();
  });
});

describe('restoreDb post-restore sanity check', () => {
  it('queries all five core table counts in one statement', async () => {
    const file = makeBackup('nomos_sanity.dump');
    installRunner({ exists: false });
    const client = installClient();

    await restore.main(['--file', file, '--target', 'nomos_db_restore_sanity']);

    const sql = client.query.mock.calls[0][0];
    expect(sql).toMatch(/COUNT\(\*\)::bigint AS row_count/);
    for (const table of [
      'users',
      'conversations',
      'messages',
      'legal_documents',
      'legislation_embeddings'
    ]) {
      expect(sql).toMatch(new RegExp(`'${table}' AS table_name`));
      expect(sql).toMatch(new RegExp(`FROM ${table}\\b`));
    }
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('fails non-zero when the sanity query cannot read the restored schema', async () => {
    const file = makeBackup('nomos_sanity_fail.dump');
    installRunner({ exists: false });
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockRejectedValue(new Error('relation "users" does not exist')),
      end: jest.fn().mockResolvedValue(undefined)
    };
    Client.mockImplementation(() => client);

    await expect(
      restore.main(['--file', file, '--target', 'nomos_db_restore_bad'])
    ).rejects.toThrow(/Post-restore sanity check failed/);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

describe('restoreDb password handling', () => {
  it('never puts the password in argv or logs; it only uses PGPASSWORD env', async () => {
    const file = makeBackup('nomos_secret.dump');
    const calls = installRunner({ exists: false });
    installClient();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await restore.main(['--file', file, '--target', 'nomos_db_restore_secret']);

    expect(logSpy.mock.calls.flat().join(' ')).not.toContain(PASSWORD);
    expect(logSpy.mock.calls.flat().join(' ')).toContain('pg_restore');

    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(PASSWORD);
      if (call.options && call.options.env && 'PGPASSWORD' in call.options.env) {
        expect(call.options.env.PGPASSWORD).toBe(PASSWORD);
      }
    }
  });

  it('redacts the password from stderr surfaced by a failed restore', async () => {
    const file = makeBackup('nomos_secret_error.dump');
    installRunner({
      exists: false,
      fail: (command, args) =>
        command === 'pg_restore' && !args.includes('--version')
          ? `fatal: password authentication failed (${PASSWORD})`
          : null
    });
    installClient();

    let error;
    try {
      await restore.main(['--file', file, '--target', 'nomos_db_restore_redact']);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).toContain('***');
  });
});
