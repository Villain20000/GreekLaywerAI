jest.mock('../src/config/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn()
}));

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const ragService = require('../src/services/ragService');
const documentService = require('../src/services/documentService');

describe('Phase B cited-answer helpers', () => {
  afterEach(() => {
    db.query.mockReset();
    ollamaService.generateEmbedding.mockReset();
  });

  it('normalizes legislation and uploaded-document hits into safe source metadata', () => {
    const sources = ragService.toSources([
      { id: 4, source_type: 'ΑΚ', article_number: '57', title: 'Προσωπικότητα', similarity: 0.9 },
      { document_id: 8, filename: 'contract.txt', title: 'Σύμβαση', chunk_index: 2, similarity: 0.8 }
    ]);

    expect(sources).toEqual([
      expect.objectContaining({ type: 'legislation', id: 4, articleNumber: '57' }),
      expect.objectContaining({ type: 'document', id: 8, chunkIndex: 2, filename: 'contract.txt' })
    ]);
    expect(ragService.calculateConfidence(sources)).toBe(0.85);
  });

  it('scopes selected document retrieval by owner and selected ids', async () => {
    ollamaService.generateEmbedding.mockResolvedValueOnce([0.1, 0.2, 0.3]);
    db.query.mockResolvedValueOnce({ rows: [] });

    await documentService.searchUserDocuments('όρος σύμβασης', 7, 5, [8, 9]);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE d\.user_id = \$2/);
    expect(sql).toMatch(/d\.id = ANY\(\$4::int\[\]\)/);
    expect(params).toEqual(['[0.1,0.2,0.3]', 7, 5, [8, 9]]);
  });
});
