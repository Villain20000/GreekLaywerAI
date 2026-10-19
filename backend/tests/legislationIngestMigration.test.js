/**
 * 1-8 — `migrate-legislation-unique-index.js` + ingest/DB contract tests.
 *
 * The ingest dedupe is only race-free if THREE things stay in lockstep:
 *   1. the migration creates a partial UNIQUE index on
 *      `legislation_embeddings(source_type, article_number)`;
 *   2. the ON CONFLICT target in `ingestLegislation.js` repeats the
 *      exact index predicate (Postgres cannot infer a partial index
 *      otherwise);
 *   3. the migration de-duplicates legacy rows BEFORE the index build
 *      (an existing duplicate would abort CREATE UNIQUE INDEX).
 *
 * A drift in any of the three only shows up at runtime against a real
 * Postgres, so these are pinned statically + via a mocked client.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn()
}));

const db = require('../src/config/db');
const migrate = require('../src/scripts/migrate-legislation-unique-index');
const { INSERT_LEGISLATION_SQL } = require('../src/scripts/ingestLegislation');

const MIGRATION_PATH = path.join(
  __dirname, '..', 'src', 'scripts', 'migrate-legislation-unique-index.js'
);

const PARTIAL_PREDICATE = 'source_type IS NOT NULL AND article_number IS NOT NULL';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});

describe('migrate-legislation-unique-index.js (1-8: race-free ingest dedupe)', () => {
  it('declares the partial unique index + legacy dedupe the ingest depends on', () => {
    const src = fs.readFileSync(MIGRATION_PATH, 'utf8');

    // Partial + nullable-safe + idempotent index.
    expect(src).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS\s+legislation_embeddings_source_article_uidx/i);
    expect(src).toMatch(/ON legislation_embeddings\(source_type, article_number\)/i);
    expect(src).toMatch(new RegExp(`WHERE ${PARTIAL_PREDICATE}`, 'i'));
    // Legacy duplicates are removed before the unique build.
    expect(src).toMatch(/DELETE FROM legislation_embeddings/i);
    expect(src).toMatch(/a\.id < b\.id/);
    // Single transaction.
    expect(src).toMatch(/await client\.query\('BEGIN'\)/);
    expect(src).toMatch(/await client\.query\('COMMIT'\)/);
    expect(src).toMatch(/ROLLBACK/);
    // Standard migrate-*.js runner shape.
    expect(src).toMatch(/require\.main === module/);
    expect(src).toMatch(/module\.exports = migrate/);
    expect(src).toMatch(/\.release\(\)/);
  });

  it('runs BEGIN → dedupe → unique index → COMMIT in one transaction', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rowCount: 0 }),
      release: jest.fn()
    };
    db.connect.mockResolvedValue(client);

    const result = await migrate();

    expect(result).toEqual({ ok: true });
    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');

    const dedupeSql = sqls.find((s) => /DELETE FROM legislation_embeddings/i.test(s));
    expect(dedupeSql).toMatch(/a\.source_type = b\.source_type/);
    expect(dedupeSql).toMatch(/a\.article_number = b\.article_number/);

    const indexSql = sqls.find((s) => /CREATE UNIQUE INDEX/i.test(s));
    expect(indexSql).toMatch(/legislation_embeddings_source_article_uidx/);
    expect(indexSql).toMatch(new RegExp(`WHERE ${PARTIAL_PREDICATE}`, 'i'));

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back + releases the client when a statement fails', async () => {
    const client = {
      query: jest.fn().mockImplementation((sql) => {
        if (/CREATE UNIQUE INDEX/i.test(sql)) {
          return Promise.reject(new Error('boom: duplicate value'));
        }
        return Promise.resolve({ rowCount: 0 });
      }),
      release: jest.fn()
    };
    db.connect.mockResolvedValue(client);

    await expect(migrate()).rejects.toThrow('boom');

    const sqls = client.query.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('ingest INSERT repeats the index predicate so Postgres can infer it', () => {
    expect(INSERT_LEGISLATION_SQL).toMatch(/INSERT INTO legislation_embeddings/i);
    expect(INSERT_LEGISLATION_SQL).toMatch(/ON CONFLICT\s*\(source_type,\s*article_number\)/i);
    expect(INSERT_LEGISLATION_SQL).toMatch(new RegExp(PARTIAL_PREDICATE, 'i'));
    expect(INSERT_LEGISLATION_SQL).toMatch(/DO NOTHING/i);
    // No legacy SELECT-then-INSERT pre-check anywhere in the upsert.
    expect(INSERT_LEGISLATION_SQL).not.toMatch(/SELECT/i);
  });
});
