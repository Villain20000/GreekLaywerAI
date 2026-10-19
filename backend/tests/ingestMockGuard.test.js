// Production must not silently index the embedded 3-article demo corpus.
// DB and Ollama are mocked; no real writes leave this process.

jest.mock('../src/config/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/ollamaService', () => ({ generateEmbedding: jest.fn() }));
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn()
  };
});

const fs = require('fs');
const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const {
  ingest,
  loadScrapedLaws,
  DEFAULT_SCRAPED_LAWS_PATH
} = require('../src/scripts/ingestLegislation');

const EMBED_VECTOR = new Array(1024).fill(0.1);
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SCRAPED_PATH = process.env.SCRAPED_LAWS_PATH;

function setScrapedState({ exists = false, json = [] } = {}) {
  fs.existsSync.mockReturnValue(exists);
  fs.readFileSync.mockReturnValue(JSON.stringify(json));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.NODE_ENV = 'production';
  delete process.env.ALLOW_MOCK_CORPUS;
  delete process.env.SCRAPED_LAWS_PATH;

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  ollamaService.generateEmbedding.mockResolvedValue(EMBED_VECTOR);
  db.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SCRAPED_PATH === undefined) delete process.env.SCRAPED_LAWS_PATH;
  else process.env.SCRAPED_LAWS_PATH = ORIGINAL_SCRAPED_PATH;
});

describe('production mock-corpus guard', () => {
  it('fails instead of falling back to mocks when the corpus file is absent', async () => {
    setScrapedState({ exists: false });

    await expect(ingest()).rejects.toThrow(/NODE_ENV=production refuses/);
    expect(fs.existsSync).toHaveBeenCalledWith(DEFAULT_SCRAPED_LAWS_PATH);
    expect(ollamaService.generateEmbedding).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('loadScrapedLaws also refuses the silent fallback', () => {
    setScrapedState({ exists: false });

    expect(() => loadScrapedLaws()).toThrow(/ALLOW_MOCK_CORPUS=true/);
  });

  it('allows mocks only with an explicit ALLOW_MOCK_CORPUS=true', async () => {
    process.env.ALLOW_MOCK_CORPUS = 'true';
    setScrapedState({ exists: false });

    const stats = await ingest();

    expect(stats).toEqual({ inserted: 3, skipped: 0, failed: 0, total: 3 });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('ingests only the real corpus in production (no demo rows mixed in)', async () => {
    setScrapedState({
      exists: true,
      json: [{
        source: 'ΦΕΚ',
        law_number: '5000/2026',
        law_title: 'Πραγματικός νόμος',
        full_text: 'Άρθρο 1. Πραγματικό κείμενο.'
      }]
    });

    const stats = await ingest();

    expect(stats).toEqual({ inserted: 1, skipped: 0, failed: 0, total: 1 });
    const articleNumbers = db.query.mock.calls.map(([, params]) => params[1]);
    expect(articleNumbers).toEqual(['5000/2026']);
  });

  it('fails when the real corpus parses to zero usable rows', async () => {
    setScrapedState({ exists: true, json: [{ law_number: '1/2026', full_text: '' }] });

    await expect(ingest()).rejects.toThrow(/no usable legislation rows/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('keeps the dev/test fallback unchanged', async () => {
    process.env.NODE_ENV = 'test';
    setScrapedState({ exists: false });

    const stats = await ingest();

    expect(stats.total).toBe(3);
  });

  it('still fails loudly for a missing explicit SCRAPED_LAWS_PATH', () => {
    process.env.SCRAPED_LAWS_PATH = '/mnt/missing/scraped_laws.json';
    fs.existsSync.mockReturnValue(false);

    expect(() => loadScrapedLaws()).toThrow(/SCRAPED_LAWS_PATH points to/);
  });
});
