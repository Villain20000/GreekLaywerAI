process.env.NODE_ENV = 'test';

const ansvarMcpService = require('../src/services/ansvarMcpService');

jest.mock('../src/config/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/ollamaService', () => ({ generateEmbedding: jest.fn() }));
jest.mock('../src/services/cacheService', () => ({
  hashKey: jest.fn(() => 'hash'),
  getJson: jest.fn(),
  setJson: jest.fn()
}));
jest.mock('../src/services/ansvarMcpService', () => ({
  isConfigured: jest.fn(),
  retrieveLegislation: jest.fn()
}));

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const cacheService = require('../src/services/cacheService');
const ragService = require('../src/services/ragService');

const localRows = [{ id: 1, content: 'Τοπικό άρθρο', similarity: 0.7 }];
const ansvarRows = [{
  id: 585,
  title: 'Αστικός Κώδικας',
  source_type: 'Νόμος',
  article_number: '585',
  content: 'Απάντηση από Ansvar',
  similarity: 0.93,
  provider: 'ansvar'
}];

beforeEach(() => {
  jest.clearAllMocks();
  cacheService.getJson.mockResolvedValue(null);
  cacheService.setJson.mockResolvedValue(true);
  db.query.mockResolvedValue({ rows: localRows });
  ollamaService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  ansvarMcpService.isConfigured.mockReturnValue(true);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ragService + Ansvar MCP', () => {
  it('uses Ansvar results and never touches the local embedding index', async () => {
    ansvarMcpService.retrieveLegislation.mockResolvedValue(ansvarRows);

    const result = await ragService.retrieveContext('καταγγελία μίσθωσης');

    expect(result).toEqual(ansvarRows);
    expect(ollamaService.generateEmbedding).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    const [key] = cacheService.setJson.mock.calls[0];
    expect(key).toMatch(/^rag:context:ansvar:hash:5$/);
  });

  it('falls back to pgvector when Ansvar throws', async () => {
    ansvarMcpService.retrieveLegislation.mockRejectedValue(
      new Error('Ansvar MCP HTTP 503')
    );

    const result = await ragService.retrieveContext('καταγγελία μίσθωσης');

    expect(result).toEqual(localRows);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to the local pgvector corpus')
    );
  });

  it('falls back to pgvector when Ansvar finds nothing', async () => {
    ansvarMcpService.retrieveLegislation.mockResolvedValue([]);

    const result = await ragService.retrieveContext('άγνωστη ερώτηση');

    expect(result).toEqual(localRows);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('keeps the local pgvector path when Ansvar is disabled', async () => {
    ansvarMcpService.isConfigured.mockReturnValue(false);

    const result = await ragService.retrieveContext('νόμος');

    expect(result).toEqual(localRows);
    expect(ansvarMcpService.retrieveLegislation).not.toHaveBeenCalled();
    const [key] = cacheService.setJson.mock.calls[0];
    expect(key).toBe('rag:context:hash:5');
  });
});
