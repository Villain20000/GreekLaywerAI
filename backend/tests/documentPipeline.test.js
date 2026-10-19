// 1-9: Document pipeline robustness tests.
//
// Exercises the REAL documentService against mocked db / Ollama / auditLog:
//   - document + chunk rows are written in one BEGIN/COMMIT transaction
//   - ROLLBACK + release on any write failure
//   - embeddings are batched with bounded concurrency, order preserved
//   - a failed embedding pass never opens a transaction (no orphans)

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const { logAudit } = require('../src/services/auditLog');
const documentService = require('../src/services/documentService');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn()
}));
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined)
}));

// No sentence terminators → one giant "sentence" hard-cut into several
// ~500-token chunks by chunkText(), all in a single text/plain buffer.
const SAMPLE_TEXT = 'λέξη '.repeat(4000);

function makeFile() {
  return { buffer: Buffer.from(SAMPLE_TEXT), originalname: 'doc.txt' };
}

/**
 * Transactional client mock: records every call, answers the document
 * INSERT with a row, and (optionally) fails one chunk INSERT.
 */
function makeClient({ failChunkInsertAt = null } = {}) {
  let chunkInserts = 0;
  return {
    query: jest.fn().mockImplementation(async (sql) => {
      const s = String(sql).trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (s.startsWith('INSERT INTO legal_documents')) {
        return {
          rows: [{
            id: 42,
            user_id: 2,
            filename: 'doc.txt',
            title: 'Title',
            content_type: 'text/plain',
            metadata: { word_count: 4000 },
            created_at: '2026-01-01T00:00:00Z'
          }],
          rowCount: 1
        };
      }
      if (s.startsWith('INSERT INTO legal_document_chunks')) {
        if (failChunkInsertAt !== null && chunkInserts === failChunkInsertAt) {
          chunkInserts += 1;
          throw new Error('chunk insert failed');
        }
        chunkInserts += 1;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
}

function sqlsOf(client) {
  return client.query.mock.calls.map(([sql]) => String(sql).trim());
}

function chunkInsertCalls(client) {
  return client.query.mock.calls.filter(
    ([sql]) => String(sql).trim().startsWith('INSERT INTO legal_document_chunks')
  );
}

describe('documentService.processAndStoreDocument (1-9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.connect.mockReset();
    ollamaService.generateEmbedding.mockReset();
    ollamaService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('writes document + all chunks in a single BEGIN/COMMIT transaction', async () => {
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    const expectedChunks = documentService.chunkText(SAMPLE_TEXT);
    expect(expectedChunks.length).toBeGreaterThan(3);

    const { document, chunkCount } = await documentService.processAndStoreDocument(
      2, makeFile(), 'text/plain', '  Title  '
    );

    expect(document.id).toBe(42);
    expect(chunkCount).toBe(expectedChunks.length);

    const sqls = sqlsOf(client);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls.filter((s) => s === 'ROLLBACK')).toHaveLength(0);

    // Every write went through the transactional client — no pool queries
    // (auditLog is mocked in this suite).
    expect(db.query).not.toHaveBeenCalled();

    const documentInsert = client.query.mock.calls.find(
      ([sql]) => String(sql).trim().startsWith('INSERT INTO legal_documents')
    );
    // file_url is intentionally always NULL until object storage exists.
    expect(documentInsert[1][3]).toBeNull();
    expect(documentInsert[1][2]).toBe('Title'); // normalized title

    // Chunks inserted in text order with sequential chunk_index.
    const chunkCalls = chunkInsertCalls(client);
    expect(chunkCalls).toHaveLength(expectedChunks.length);
    chunkCalls.forEach(([, params], i) => {
      expect(params[0]).toBe(42); // document id
      expect(params[1]).toBe(expectedChunks[i]); // content in order
      expect(params[3]).toBe(i); // chunk_index in order
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'document.uploaded', resourceId: 42 })
    );
  });

  it('ROLLBACKs and releases the client when a chunk INSERT fails', async () => {
    const client = makeClient({ failChunkInsertAt: 1 });
    db.connect.mockResolvedValueOnce(client);

    await expect(
      documentService.processAndStoreDocument(2, makeFile(), 'text/plain', null)
    ).rejects.toThrow('chunk insert failed');

    const sqls = sqlsOf(client);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('never opens a transaction when an embedding call fails (no orphan rows)', async () => {
    let calls = 0;
    ollamaService.generateEmbedding.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('embedding failed');
      return [0.1, 0.2, 0.3];
    });

    await expect(
      documentService.processAndStoreDocument(2, makeFile(), 'text/plain', null)
    ).rejects.toThrow('embedding failed');

    // Nothing was written and no pooled connection was checked out.
    expect(db.connect).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('bounds embedding concurrency to 3 in flight and keeps chunk order', async () => {
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    const expectedChunks = documentService.chunkText(SAMPLE_TEXT);
    expect(expectedChunks.length).toBeGreaterThan(3);

    let active = 0;
    let maxActive = 0;
    const pending = [];
    ollamaService.generateEmbedding.mockImplementation(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((resolve) => {
        pending.push(() => {
          active -= 1;
          resolve([0.1, 0.2, 0.3]);
        });
      });
    });

    const pipeline = documentService.processAndStoreDocument(
      2, makeFile(), 'text/plain', null
    );

    // Let the pipeline reach the embedding pool.
    await new Promise((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(3); // pool cap, not all chunks at once

    // Drain the deferred embeddings, one per event-loop turn.
    while (pending.length) {
      pending.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await pipeline;

    expect(maxActive).toBe(3);
    expect(ollamaService.generateEmbedding).toHaveBeenCalledTimes(expectedChunks.length);

    const chunkIndexes = chunkInsertCalls(client).map(([, params]) => params[3]);
    expect(chunkIndexes).toEqual(expectedChunks.map((_, i) => i));
  });

  it('no longer exports the dead extractText helper', () => {
    expect(documentService.extractText).toBeUndefined();
  });
});
