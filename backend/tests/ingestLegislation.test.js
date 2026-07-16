/**
 * Phase 26 — Tests for ingestLegislation.js (scrape → RAG wiring).
 *
 * The script is the bridge between `prototype_scraper.py`'s
 * `scraped_laws.json` output and Postgres' `legislation_embeddings`
 * table. Without this bridge, the LLM has only the placeholder
 * mock articles in its context and answers are unhelpful.
 *
 * Coverage here focuses on three spots that are easy to break
 * silently:
 *
 *   1. `loadScrapedLaws()` reads + normalizes the scraper output.
 *      A schema mismatch here would leak raw `full_text` into the
 *      wrong DB column or, worse, skip every row because of a key
 *      rename (`law_title` vs `title`).
 *
 *   2. The fallback path when `scraped_laws.json` is missing or
 *      corrupt. The script MUST NOT crash — it should just fall
 *      back to the 3 mock articles so a brand-new env still works.
 *
 *   3. `ingest()` idempotency. Re-running the script must not
 *      duplicate rows (would skew pgvector similarity scores) —
 *      the SELECT-then-INSERT guard is the only line of defense.
 */
const path = require('path');
const fs = require('fs');

// Hoist mocks BEFORE the SUT is required.
jest.mock('../src/config/db', () => ({
  query: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn().mockResolvedValue(
    new Array(768).fill(0).map((_, i) => (i % 7) / 7)
  )
}));

// Patch fs so we don't hit the real filesystem. Each test sets up its
// own scratch state via the `_setScrapedState` helper.
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
const { loadScrapedLaws, ingest, alreadyExists } =
  require('../src/scripts/ingestLegislation');

// Scratch state used by the helper below; reset per test.
function _setScrapedState({ exists = true, json = null, parseError = false } = {}) {
  fsMock.existsSync.mockReturnValue(exists);
  fsMock.readFileSync.mockImplementation(() => {
    if (parseError) throw new Error('SYNTAX ERROR: bad JSON');
    return JSON.stringify(json);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Silence per-row info/warn logs so the test stdout stays clean.
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  // Default: no rows exist yet — the SELECT-then-INSERT guard returns
  // false and we INSERT.
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('ingestLegislation.js (Phase 26: scrape → RAG wiring)', () => {
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
    });

    it('falls back to [] when scraped_laws.json does not exist', () => {
      _setScrapedState({ exists: false });
      const result = loadScrapedLaws();
      expect(result).toEqual([]);
      expect(fsMock.existsSync).toHaveBeenCalled();
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
    it('inserts scraped + mock rows with the correct SQL shape', async () => {
      // 1 scraped row + 3 mock rows = 4 INSERTs in total. All are
      // "new" because the SELECT-then-INSERT guard returns empty
      // (default mock: db.query → rows: []).
      _setScrapedState({
        json: [{
          source: 'Hellenic Parliament',
          law_title: 'Executive State org',
          law_number: '4622/2019',
          full_text: 'Executive State: organization, operation and transparency.'
        }]
      });

      await ingest();

      // 4 SELECT-then-INSERT iterations × 1 SELECT each = 4 SELECTs,
      // then 4 INSERTs. We assert the total + the shape of one INSERT.
      const calls = db.query.mock.calls;
      // Every iteration calls SELECT first.
      expect(calls.length).toBeGreaterThanOrEqual(4);
      // The INSERT calls must include one matching the scraped law.
      const insertCalls = calls.filter(
        ([sql]) => typeof sql === 'string' && /INSERT INTO legislation_embeddings/i.test(sql)
      );
      expect(insertCalls.length).toBe(4);
      // One of them must carry the scraped law's fields.
      const scrapedInsert = insertCalls.find(
        ([, params]) => params && params[1] === '4622/2019'
      );
      expect(scrapedInsert).toBeDefined();
      expect(scrapedInsert[1][0]).toBe('Hellenic Parliament');
      expect(scrapedInsert[1][2]).toBe('Executive State org');
      // Embedding vector string must be valid `[x,y,z...vector]` shape
      // so pgvector can parse it.
      expect(scrapedInsert[1][4]).toMatch(/^\[.*\]$/);
    });

    it('skips already-ingested rows so re-runs are idempotent', async () => {
      _setScrapedState({
        json: [{
          law_number: '4622/2019',
          source: 'Hellenic Parliament',
          law_title: 'Already ingested',
          full_text: 'should be skipped'
        }]
      });

      // Mock the per-row SELECT inside alreadyExists() so that ONLY
      // the scraped (Hellenic Parliament, 4622/2019) row is reported as
      // already-present. The 3 mock rows (Αστικός/Ποινικός Κώδικας)
      // are new and must be INSERTed.
      db.query.mockImplementation((sql, params) => {
        if (typeof sql === 'string' && /SELECT 1 FROM legislation_embeddings/i.test(sql)) {
          // `params` is [source_type, article_number] for alreadyExists.
          const [sourceType, articleNumber] = params || [];
          if (sourceType === 'Hellenic Parliament' && articleNumber === '4622/2019') {
            return Promise.resolve({ rows: [{ exists: 1 }], rowCount: 1 });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        // INSERT (or any other non-SELECT) — empty return is fine.
        return Promise.resolve({ rows: [], rowCount: 1 });
      });

      await ingest();

      // Exactly 3 INSERTs (the mocks) should have fired. No INSERT for
      // the scraped row that was already in the DB.
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && /INSERT INTO legislation_embeddings/i.test(sql)
      );
      expect(insertCalls.length).toBe(3);
      // None of the INSERT params must be '4622/2019'.
      const insertedArticleNumbers = insertCalls.map(([, p]) => p && p[1]);
      expect(insertedArticleNumbers).not.toContain('4622/2019');
    });

    it('sets process.exitCode=1 if any row failed (operator signal)', async () => {
      _setScrapedState({ exists: false });
      // Force generateEmbedding to throw → every row fails. alreadyExists
      // still calls db.query (returns the default empty rows) but never
      // reaches the embedding step.
      ollamaService.generateEmbedding.mockRejectedValue(
        new Error('embed model not pulled')
      );

      delete process.exitCode;
      await ingest();

      expect(process.exitCode).toBe(1);
      // No INSERTs should have been issued because nothing got embedded.
      const insertCalls = db.query.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && /INSERT INTO legislation_embeddings/i.test(sql)
      );
      expect(insertCalls.length).toBe(0);
    });
  });

  describe('alreadyExists()', () => {
    it('returns true when the SELECT finds a match', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ exists: 1 }], rowCount: 1 });
      const exists = await alreadyExists('Foo', '1/2020');
      expect(exists).toBe(true);
    });

    it('returns false when the SELECT finds no match', async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const exists = await alreadyExists('Foo', '1/2020');
      expect(exists).toBe(false);
    });

    it('queries legislation_embeddings with the expected predicate', async () => {
      db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await alreadyExists('Foo', '1/2020');
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toMatch(/SELECT 1 FROM legislation_embeddings/i);
      expect(sql).toMatch(/source_type\s*=\s*\$1/);
      expect(sql).toMatch(/article_number\s*=\s*\$2/);
      expect(params).toEqual(['Foo', '1/2020']);
    });
  });
});
