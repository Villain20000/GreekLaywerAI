/**
 * Phase 26 / 1-8 — Tests for ingestLegislation.js (scrape → RAG wiring).
 *
 * The script is the bridge between `prototype_scraper.py`'s
 * `scraped_laws.json` output and Postgres' `legislation_embeddings`
 * table. Without this bridge, the LLM has only the placeholder
 * mock articles in its context and answers are unhelpful.
 *
 * Coverage here focuses on four spots that are easy to break silently:
 *
 *   1. `loadScrapedLaws()` reads + normalizes the scraper output.
 *      A schema mismatch here would leak raw `full_text` into the
 *      wrong DB column or, worse, skip every row because of a key
 *      rename (`law_title` vs `title`).
 *
 *   2. `SCRAPED_LAWS_PATH` (1-8): the env var MUST win over the
 *      default path, and a broken override must fail loudly instead
 *      of silently ingesting the mocks.
 *
 *   3. The fallback path when `scraped_laws.json` is missing or
 *      corrupt. The script MUST NOT crash — it should just fall
 *      back to the 3 mock articles so a brand-new env still works.
 *
 *   4. `ingest()` idempotency. Re-running the script must not
 *      duplicate rows (would skew pgvector similarity scores) —
 *      now enforced race-free by `INSERT ... ON CONFLICT DO NOTHING`
 *      against the partial unique index from
 *      `migrate-legislation-unique-index.js`.
 */
const path = require('path');
const fs = require('fs');

// Hoist mocks BEFORE the SUT is required.
jest.mock('../src/config/db', () => ({
  query: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn()
}));

// Patch fs so we don't hit the real filesystem. Each test sets up its
// own scratch state via the `_setScrapedState` helper. (The real-file
// SCRAPED_LAWS_PATH coverage lives in legislationIngestEnvPath.test.js,
// which uses a checked-in fixture.)
jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    existsSync: jest.fn(),
    readFileSync: jest.fn()
  };
});

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const fsMock = fs; // already mocked above
const {
  loadScrapedLaws,
  resolveScrapedLawsPath,
  ingest,
  INSERT_LEGISLATION_SQL,
  DEFAULT_SCRAPED_LAWS_PATH
} = require('../src/scripts/ingestLegislation');

const EMBED_VECTOR = new Array(768).fill(0).map((_, i) => (i % 7) / 7);

// Scratch state used by the helper below; reset per test.
function _setScrapedState({ exists = true, json = null, parseError = false } = {}) {
  fsMock.existsSync.mockReturnValue(exists);
  fsMock.readFileSync.mockImplementation(() => {
    if (parseError) throw new Error('SYNTAX ERROR: bad JSON');
    return JSON.stringify(json);
  });
}

beforeEach(() => {
  // Deterministic env: tests that exercise SCRAPED_LAWS_PATH set it
  // explicitly; everything else must see the default-path behavior.
  delete process.env.SCRAPED_LAWS_PATH;
  jest.clearAllMocks();
  // Silence per-row info/warn logs so the test stdout stays clean.
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  // Restore the default embed success (mockReset in a prior test may have
  // removed it).
  ollamaService.generateEmbedding.mockReset();
  ollamaService.generateEmbedding.mockResolvedValue(EMBED_VECTOR);
  // Default: the insert succeeds (rowCount 1 = row written).
  db.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

describe('ingestLegislation.js (Phase 26: scrape → RAG wiring)', () => {
  describe('resolveScrapedLawsPath()', () => {
    it('returns the default path when SCRAPED_LAWS_PATH is unset', () => {
      expect(resolveScrapedLawsPath()).toEqual({
        path: DEFAULT_SCRAPED_LAWS_PATH,
        fromEnv: false
      });
    });

    it('prefers SCRAPED_LAWS_PATH over the default (the 1-8 bug)', () => {
      process.env.SCRAPED_LAWS_PATH = '/mnt/scraped/scraped_laws.json';
      expect(resolveScrapedLawsPath()).toEqual({
        path: '/mnt/scraped/scraped_laws.json',
        fromEnv: true
      });
    });

    it('treats a blank SCRAPED_LAWS_PATH as unset', () => {
      process.env.SCRAPED_LAWS_PATH = '   ';
      expect(resolveScrapedLawsPath()).toEqual({
        path: DEFAULT_SCRAPED_LAWS_PATH,
        fromEnv: false
      });
    });
  });

  describe('loadScrapedLaws()', () => {
    it('reads scraped_laws.json + normalizes each law into the DB row shape', () => {
      _setScrapedState({
        json: [{
          id: '0319db24-895f-417a-bc37-8dd2c97446f6',
          source: 'Hellenic Parliament',
          law_title: 'Executive State organization',
          law_number: '4622/2019',
          fek_reference: "A' 133",
          publication_date: '2019-08-07',
          full_text: 'Executive State: organization, operation and transparency.'
        }]
      });

      const result = loadScrapedLaws();

      expect(result).toHaveLength(1);
      // Phase 26 schema mapping: scraper's canonical fields → DB row shape.
      expect(result[0]).toEqual({
        source_type: 'Hellenic Parliament',
        article_number: '4622/2019',
        title: 'Executive State organization',
        content: 'Executive State: organization, operation and transparency.'
      });
      // Default path (no env) used.
      expect(fsMock.existsSync).toHaveBeenCalledWith(DEFAULT_SCRAPED_LAWS_PATH);
    });

    it('reads the file pointed to by SCRAPED_LAWS_PATH (not the default)', () => {
      process.env.SCRAPED_LAWS_PATH = '/virtual/mnt/scraped_laws.json';
      _setScrapedState({
        json: [{
          source: 'ΦΕΚ',
          law_title: 'Δοκιμαστικός νόμος',
          law_number: '5000/2026',
          full_text: 'Άρθρο 1. Δοκιμαστικό κείμενο.'
        }]
      });

      const result = loadScrapedLaws();

      expect(fsMock.existsSync).toHaveBeenCalledWith('/virtual/mnt/scraped_laws.json');
      expect(fsMock.existsSync).not.toHaveBeenCalledWith(DEFAULT_SCRAPED_LAWS_PATH);
      expect(fsMock.readFileSync).toHaveBeenCalledWith('/virtual/mnt/scraped_laws.json', 'utf8');
      expect(result).toEqual([{
        source_type: 'ΦΕΚ',
        article_number: '5000/2026',
        title: 'Δοκιμαστικός νόμος',
        content: 'Άρθρο 1. Δοκιμαστικό κείμενο.'
      }]);
    });

    it('fails loudly when SCRAPED_LAWS_PATH points at a missing file (no silent mock fallback)', () => {
      process.env.SCRAPED_LAWS_PATH = '/virtual/mnt/does-not-exist.json';
      _setScrapedState({ exists: false });

      expect(() => loadScrapedLaws()).toThrow(/SCRAPED_LAWS_PATH/);
      expect(() => loadScrapedLaws()).toThrow(/does-not-exist\.json/);
      // Never try to read a file we know is missing.
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
    });

    it('falls back to [] when the DEFAULT scraped_laws.json does not exist', () => {
      _setScrapedState({ exists: false });
      const result = loadScrapedLaws();
      expect(result).toEqual([]);
      expect(fsMock.existsSync).toHaveBeenCalledWith(DEFAULT_SCRAPED_LAWS_PATH);
      // readFileSync must NOT be invoked when file is absent.
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
    });

    it('falls back to [] when scraped_laws.json is corrupt', () => {
      _setScrapedState({ parseError: true });
      const result = loadScrapedLaws();
      expect(result).toEqual([]);
    });

    it('drops rows missing critical fields rather than insert NULLs', () => {
      _setScrapedState({
        json: [
          // Good row
          {
            law_number: '4622/2019',
            source: 'Hellenic Parliament',
            law_title: 'OK law',
            full_text: 'valid text'
          },
          // Missing law_number — drop
          { source: 'X', full_text: 'no number here' },
          // Empty full_text — drop
          {
            source: 'Y',
            law_number: '1/2020',
            full_text: '   '
          },
          // Missing source → uses default 'Unknown Source' but row kept
          {
            law_number: '2/2020',
            full_text: 'kept, unknown source'
          }
        ]
      });

      const result = loadScrapedLaws();
      expect(result).toHaveLength(2);
      expect(result[0].article_number).toBe('4622/2019');
      expect(result[1].source_type).toBe('Unknown Source');
      expect(result[1].article_number).toBe('2/2020');
    });
  });

  describe('ingest()', () => {
    it('inserts scraped + mock rows with a race-free ON CONFLICT upsert', async () => {
      // 1 scraped row + 3 mock rows = 4 INSERTs in total.
      _setScrapedState({
        json: [{
          source: 'Hellenic Parliament',
          law_title: 'Executive State org',
          law_number: '4622/2019',
          full_text: 'Executive State: organization, operation and transparency.'
        }]
      });

      const stats = await ingest();

      expect(stats).toEqual({ inserted: 4, skipped: 0, failed: 0, total: 4 });

      const calls = db.query.mock.calls;
      expect(calls).toHaveLength(4);
      // No SELECT-then-INSERT pre-check may remain: every query is the
      // single race-free upsert.
      for (const [sql] of calls) {
        expect(sql).toMatch(/INSERT INTO legislation_embeddings/i);
        expect(sql).toMatch(/ON CONFLICT\s*\(source_type,\s*article_number\)/i);
        expect(sql).toMatch(/WHERE source_type IS NOT NULL AND article_number IS NOT NULL/i);
        expect(sql).toMatch(/DO NOTHING/i);
      }
      // The exported SQL constant matches too (used by the migration test
      // to stay in lockstep with the partial unique index predicate).
      expect(INSERT_LEGISLATION_SQL).toMatch(/ON CONFLICT\s*\(source_type,\s*article_number\)/i);
      expect(INSERT_LEGISLATION_SQL).toMatch(/DO NOTHING/i);

      // One of them must carry the scraped law's fields.
      const scrapedInsert = calls.find(
        ([, params]) => params && params[1] === '4622/2019'
      );
      expect(scrapedInsert).toBeDefined();
      expect(scrapedInsert[1][0]).toBe('Hellenic Parliament');
      expect(scrapedInsert[1][2]).toBe('Executive State org');
      // Embedding vector string must be valid `[x,y,z...vector]` shape
      // so pgvector can parse it.
      expect(scrapedInsert[1][4]).toMatch(/^\[.*\]$/);
    });

    it('re-running the same fixture is idempotent (DB discards conflicts)', async () => {
      _setScrapedState({
        json: [{
          law_number: '4622/2019',
          source: 'Hellenic Parliament',
          law_title: 'Already ingested',
          full_text: 'should be skipped on the second run'
        }]
      });

      // Fake Postgres with the partial unique index: the FIRST insert of a
      // (source_type, article_number) pair writes a row (rowCount 1); any
      // later insert conflicts → ON CONFLICT DO NOTHING → rowCount 0.
      const present = new Set();
      db.query.mockImplementation((sql, params) => {
        if (typeof sql === 'string' && /INSERT INTO legislation_embeddings/i.test(sql)) {
          const key = `${params[0]}\u0000${params[1]}`;
          if (present.has(key)) {
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          present.add(key);
          return Promise.resolve({ rows: [{ id: present.size }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });

      const first = await ingest();
      const second = await ingest();

      // First run writes all 4 rows (1 scraped + 3 mocks); the second run
      // conflicts on all of them and inserts nothing.
      expect(first).toEqual({ inserted: 4, skipped: 0, failed: 0, total: 4 });
      expect(second).toEqual({ inserted: 0, skipped: 4, failed: 0, total: 4 });
      // Exactly 4 distinct keys ever reached the DB — no duplicates.
      expect(present.size).toBe(4);
      expect(present.has('Hellenic Parliament\u00004622/2019')).toBe(true);
    });

    it('sets process.exitCode=1 if any row failed (operator signal)', async () => {
      _setScrapedState({ exists: false });
      // Force generateEmbedding to throw → every row fails.
      ollamaService.generateEmbedding.mockRejectedValue(
        new Error('embed model not pulled')
      );

      delete process.exitCode;
      const stats = await ingest();

      expect(process.exitCode).toBe(1);
      // scraped_laws.json is absent → only the 3 mock rows are attempted.
      expect(stats).toEqual({ inserted: 0, skipped: 0, failed: 3, total: 3 });
      // No INSERTs should have been issued because nothing got embedded.
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && /INSERT INTO legislation_embeddings/i.test(sql)
      );
      expect(insertCalls.length).toBe(0);
    });
  });
});
