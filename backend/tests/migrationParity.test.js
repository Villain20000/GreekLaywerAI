// Migration parity guards.
//
// database/init/schema.sql only runs on a BRAND-NEW Postgres volume. Every
// table it defines must therefore also be created by an idempotent
// migrate-*.js script, otherwise an existing deployment upgraded via
// `npm run migrate` drifts behind (the P0-8 bug class: /api/documents,
// /api/conversations, /api/admin/audit-log all 500 with "relation does not
// exist").
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '../../database/init/schema.sql');
const SCRIPTS_DIR = path.join(__dirname, '../src/scripts');

function tableNames(sql) {
  const names = new Set();
  const re = /CREATE TABLE (?:IF NOT EXISTS )"?([a-z_]+)"?/gi;
  let match;
  while ((match = re.exec(sql))) names.add(match[1].toLowerCase());
  return names;
}

describe('migration parity with schema.sql', () => {
  it('creates every schema.sql table in at least one migrate-*.js script', () => {
    const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const migrationSql = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => f.startsWith('migrate-') && f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'))
      .join('\n');

    const schemaTables = tableNames(schemaSql);
    const migrationTables = tableNames(migrationSql);

    const missing = [...schemaTables].filter((t) => !migrationTables.has(t));
    expect(missing).toEqual([]);
  });

  it('migrate-all.js requires every migrate-*.js script', () => {
    const runner = fs.readFileSync(path.join(SCRIPTS_DIR, 'migrate-all.js'), 'utf8');
    const scripts = fs
      .readdirSync(SCRIPTS_DIR)
      .filter((f) => f.startsWith('migrate-') && f.endsWith('.js') && f !== 'migrate-all.js');

    const missing = scripts.filter((f) => !runner.includes(`./${f.replace(/\.js$/, '')}`));
    expect(missing).toEqual([]);
  });
});
