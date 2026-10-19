/**
 * 1-8 regression test — `SCRAPED_LAWS_PATH` is actually READ.
 *
 * The original bug: `ingestLegislation.js` documented the env override but
 * never called `process.env.SCRAPED_LAWS_PATH`, so operators pointing the
 * script at a mounted `scraped_laws.json` silently ingested the mocks
 * instead (README + docker workflows both rely on the override).
 *
 * Unlike `ingestLegislation.test.js`, this file does NOT mock `fs`: it
 * points the env var at a real checked-in fixture and asserts the fixture
 * content reaches the (mocked) database insert. No real Postgres/Ollama
 * is touched.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../src/config/db', () => ({
  query: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn()
}));

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const { loadScrapedLaws, ingest } = require('../src/scripts/ingestLegislation');

const FIXTURE_PATH = path.join(
  __dirname, '..', 'src', 'scripts', 'fixtures', 'scraped_laws.fixture.json'
);

const EMBED_VECTOR = new Array(768).fill(0).map((_, i) => (i % 7) / 7);

const ORIGINAL_ENV = process.env.SCRAPED_LAWS_PATH;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  ollamaService.generateEmbedding.mockReset();
  ollamaService.generateEmbedding.mockResolvedValue(EMBED_VECTOR);
  db.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
  process.env.SCRAPED_LAWS_PATH = FIXTURE_PATH;
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.SCRAPED_LAWS_PATH;
  } else {
    process.env.SCRAPED_LAWS_PATH = ORIGINAL_ENV;
  }
});

describe('SCRAPED_LAWS_PATH (1-8: env-var override is read)', () => {
  it('sanity: the checked-in fixture exists and is valid scraper output', () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed[0]).toHaveProperty('law_number');
    expect(parsed[0]).toHaveProperty('full_text');
  });

  it('loadScrapedLaws() reads the env-var path and normalizes its rows', () => {
    const rows = loadScrapedLaws();

    // Fixture has 3 entries; the third (empty full_text) is dropped.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      source_type: 'Fixture Gazette (FEK)',
      article_number: '1000/2026',
      title: 'Fixture law on environmental permits',
      content: 'Fixture law body: permits for renewable energy installations are issued within sixty days.'
    });
    expect(rows[1].article_number).toBe('1001/2026');
  });

  it('ingest() embeds + upserts the env-var fixture rows (mocked DB)', async () => {
    const stats = await ingest();

    // 2 valid fixture rows + the 3 built-in mock articles.
    expect(stats).toEqual({ inserted: 5, skipped: 0, failed: 0, total: 5 });

    const insertedArticleNumbers = db.query.mock.calls.map(([, params]) => params[1]);
    expect(insertedArticleNumbers).toContain('1000/2026');
    expect(insertedArticleNumbers).toContain('1001/2026');
    // Dropped fixture row must never be inserted.
    expect(insertedArticleNumbers).not.toContain('1002/2026');
    // Every statement is the race-free upsert.
    for (const [sql] of db.query.mock.calls) {
      expect(sql).toMatch(/ON CONFLICT/i);
      expect(sql).toMatch(/DO NOTHING/i);
    }
  });

  it('fails with a clear message when the env-var file does not exist', () => {
    process.env.SCRAPED_LAWS_PATH = path.join(__dirname, 'no-such-fixture.json');
    expect(() => loadScrapedLaws()).toThrow(/SCRAPED_LAWS_PATH points to/);
  });
});
