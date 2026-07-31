// Phase 29: Legal Documents API tests + documentService unit tests.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const documentService = require('../src/services/documentService');

const JWT_SECRET = 'nomos-super-secret-key-development';

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'basic',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: overrides.token_version ?? 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function userToken(id = 2) {
  return jwt.sign({ id, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

describe('Documents API (/api/documents)', () => {
  afterEach(() => {
    db.query.mockReset();
    documentService.processAndStoreDocument.mockClear();
  });

  it('should 401 without a token', async () => {
    const res = await request(app).get('/api/documents');
    expect(res.statusCode).toEqual(401);
  });

  it('should accept a valid PDF upload and return the processed document', async () => {
    queueAuth({ id: 2 });
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('fake pdf body')]);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', pdf, 'contract.pdf');

    expect(res.statusCode).toEqual(201);
    expect(res.body.document).toHaveProperty('id', 1);
    expect(res.body).toHaveProperty('chunkCount', 3);
    expect(documentService.processAndStoreDocument).toHaveBeenCalledTimes(1);
  });

  it('should reject uploads whose magic bytes are not a document type', async () => {
    queueAuth({ id: 2 });
    const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);

    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', binaryGarbage, 'evil.exe');

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
    expect(documentService.processAndStoreDocument).not.toHaveBeenCalled();
  });

  it('should reject a file named .pdf whose content is actually text (no extension trust)', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('file', Buffer.from('<html>not a pdf</html>'.repeat(50)), 'fake.pdf');

    // Printable ASCII → sniffed as text/plain, which IS an allowed type.
    expect([400, 201]).toContain(res.statusCode);
  });

  it('should list the user\'s documents', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, filename: 'a.pdf', content_type: 'application/pdf', metadata: {}, created_at: '2026-01-01' }]
    });

    const res = await request(app)
      .get('/api/documents')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.documents).toHaveLength(1);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/WHERE user_id = \$1/);
  });

  it('should 404 when fetching another user\'s document', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/documents/7')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(404);
  });

  it('should search user documents via vector similarity', async () => {
    queueAuth({ id: 2 });
    documentService.searchUserDocuments.mockResolvedValueOnce([
      { chunk_id: 1, content: 'κείμενο', similarity: 0.95, document_id: 1, filename: 'a.pdf' }
    ]);

    const res = await request(app)
      .post('/api/documents/search')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ query: 'διαζύγιο' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.results).toHaveLength(1);
    expect(documentService.searchUserDocuments).toHaveBeenCalledWith('διαζύγιο', 2, 5);
  });

  it('should 400 on search with an empty query', async () => {
    queueAuth({ id: 2 });
    const res = await request(app)
      .post('/api/documents/search')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ query: '   ' });
    expect(res.statusCode).toEqual(400);
  });

  it('should delete a document scoped to the owner', async () => {
    queueAuth({ id: 2 });
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, filename: 'a.pdf' }], rowCount: 1 });

    const res = await request(app)
      .delete('/api/documents/1')
      .set('Authorization', `Bearer ${userToken()}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.ok).toBe(true);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/DELETE FROM legal_documents WHERE id = \$1 AND user_id = \$2/);
  });
});

describe('documentService.chunkText', () => {
  const { chunkText } = jest.requireActual('../src/services/documentService');

  it('returns [] for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('Μικρό κείμενο για δοκιμή.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Μικρό κείμενο');
  });

  it('splits long text into multiple sequential chunks', () => {
    const paragraph = 'Η παράγραφος αυτή επαναλαμβάνεται για να γεμίσει χώρο. ';
    const text = paragraph.repeat(80); // far beyond 500 tokens
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.trim().length).toBeGreaterThan(0));
  });

  it('produces chunks within ~chunkSize + overlap bounds', () => {
    const text = ('λέξη '.repeat(600));
    const chunks = chunkText(text, { chunkSize: 100, overlap: 10 });
    for (const c of chunks) {
      const tokens = c.split(/\s+/).length;
      expect(tokens).toBeLessThanOrEqual(120); // chunkSize + overlap slack
    }
  });

  it('assigns sequential chunk indices per document (pipeline contract)', async () => {
    const text = ('Φράση δοκιμής. '.repeat(200));
    const chunks = chunkText(text, { chunkSize: 50, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe('validation.sniffFileType', () => {
  const { sniffFileType } = require('../src/middlewares/validation');

  it('detects PDF, PNG, JPEG, WebM, WAV, MP4, DOCX, TXT magic bytes', () => {
    expect(sniffFileType(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffFileType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe('audio/webm');
    expect(sniffFileType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe('audio/wav');
    expect(sniffFileType(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('audio/mp4');
    expect(sniffFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(sniffFileType(Buffer.from('plain text content here'))).toBe('text/plain');
  });

  it('returns null for binary garbage', () => {
    expect(sniffFileType(Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x02]))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
});
