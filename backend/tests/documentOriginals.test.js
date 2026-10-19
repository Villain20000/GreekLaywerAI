// Original-file persistence + download tests.
//
// Exercises the REAL documentService and documents router against mocked
// db / Ollama / auditLog / pdf-parse, covering:
//   - upload stores the exact bytes + file_size in the document INSERT
//   - GET /:id/content streams the original with safe download headers
//   - legacy NULL original_file falls back to parsed text
//   - ?format=text always returns parsed text
//   - content is scoped to the owner (cross-user 404)
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../src/config/db', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));
jest.mock('../src/services/ollamaService', () => ({
  generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3])
}));
jest.mock('../src/services/auditLog', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('pdf-parse', () =>
  jest.fn().mockResolvedValue({ text: 'Εξαγόμενο κείμενο PDF', numpages: 1, info: {} })
);

const db = require('../src/config/db');
const ollamaService = require('../src/services/ollamaService');
const documentsRouter = require('../src/routes/documents');
const { authMiddleware } = require('../src/middlewares/authMiddleware');

const JWT_SECRET = 'nomos-super-secret-key-development';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/documents', authMiddleware, documentsRouter);
  return app;
}

const app = buildApp();

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

// Auth middleware reads the user row first; subsequent db.query calls default
// to empty rows unless a test queues a one-off response.
function queueAuth(id = 2) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id,
      email: 'user@nomos.ai',
      role: 'user',
      subscription_tier: 'basic',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function makeClient() {
  return {
    query: jest.fn().mockImplementation(async (sql, params) => {
      const s = String(sql).trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (s.startsWith('INSERT INTO legal_documents')) {
        return {
          rows: [{
            id: 11,
            user_id: 2,
            filename: 'contract.pdf',
            title: null,
            content_type: 'application/pdf',
            metadata: JSON.parse(params[6]),
            file_size: params[8],
            created_at: '2026-01-01T00:00:00Z'
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from([0x00, 0xff, 0x01, 0x02]),
  Buffer.from('fake pdf body')
]);

describe('document originals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    db.connect.mockReset();
    ollamaService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('stores the exact uploaded bytes and file_size in the document INSERT', async () => {
    queueAuth();
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', PDF_BYTES, 'contract.pdf');

    expect(res.statusCode).toBe(201);
    expect(res.body.document.file_size).toBe(PDF_BYTES.length);
    expect(res.body.document.original_file).toBeUndefined();

    const insertCall = client.query.mock.calls.find(
      ([sql]) => String(sql).trim().startsWith('INSERT INTO legal_documents')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall[1];

    expect(Buffer.isBuffer(params[7])).toBe(true);
    expect(params[7].equals(PDF_BYTES)).toBe(true);
    expect(params[8]).toBe(PDF_BYTES.length);

    const sqls = client.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('streams the original bytes with safe attachment headers', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 9,
        filename: 'Σύμβαση\r\n/α.pdf',
        content_type: 'application/pdf',
        parsed_text: 'κείμενο',
        original_file: PDF_BYTES
      }]
    });

    const res = await request(app)
      .get('/api/documents/9/content?download=1')
      .set('Authorization', `Bearer ${userToken()}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.equals(PDF_BYTES)).toBe(true);

    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).not.toMatch(/[\r\n]/);

    const asciiFallback = /filename="([^"]*)"/.exec(disposition)[1];
    expect([...asciiFallback].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126)).toBe(true);

    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)[1];
    expect(decodeURIComponent(encoded)).toBe('Σύμβαση_α.pdf');
  });

  it('falls back to parsed text for legacy rows with NULL original_file', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 3,
        filename: 'legacy.pdf',
        content_type: 'application/pdf',
        parsed_text: 'Παλιό εξαγόμενο κείμενο',
        original_file: null
      }]
    });

    const res = await request(app)
      .get('/api/documents/3/content')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['content-disposition']).toContain('doc-3.txt');
    expect(res.text).toBe('Παλιό εξαγόμενο κείμενο');
  });

  it('returns parsed text for ?format=text even when original bytes exist', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 8,
        filename: 'contract.pdf',
        content_type: 'application/pdf',
        parsed_text: 'Μόνο το κείμενο',
        original_file: PDF_BYTES
      }]
    });

    const res = await request(app)
      .get('/api/documents/8/content?format=text')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toBe('Μόνο το κείμενο');
  });

  it('returns 404 for another user\'s document content', async () => {
    queueAuth(2);
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/documents/77/content')
      .set('Authorization', `Bearer ${userToken(2)}`);

    expect(res.statusCode).toBe(404);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
  });

  it('includes file_size in list and details responses', async () => {
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        filename: 'a.pdf',
        title: null,
        content_type: 'application/pdf',
        metadata: {},
        file_size: 1234,
        created_at: '2026-01-01T00:00:00Z'
      }]
    });

    const list = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.documents[0].file_size).toBe(1234);
    expect(db.query.mock.calls[1][0]).toMatch(/file_size/);

    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        filename: 'a.pdf',
        title: null,
        content_type: 'application/pdf',
        metadata: {},
        file_size: 1234,
        chunk_count: '2',
        created_at: '2026-01-01T00:00:00Z'
      }]
    });

    const detail = await request(app)
      .get('/api/documents/1')
      .set('Authorization', `Bearer ${userToken()}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.document.file_size).toBe(1234);
    expect(db.query.mock.calls[3][0]).toMatch(/file_size/);
  });

  it('streams DOCX bytes untouched with the stored content type', async () => {
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    queueAuth();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 12,
        filename: 'συμβόλαιο.docx',
        content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parsed_text: 'κείμενο',
        original_file: docx
      }]
    });

    const res = await request(app)
      .get('/api/documents/12/content')
      .set('Authorization', `Bearer ${userToken()}`)
      .buffer(true)
      .parse(binaryParser);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/wordprocessingml\.document/);
    expect(res.body.equals(docx)).toBe(true);
  });
});
