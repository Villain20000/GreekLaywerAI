// Phase 1-7: real multimodal handling.
//
// PDF/DOCX uploads are text-extracted through the shared document pipeline
// (documentService.extractMetadata — mocked here, matching tests/app.js) and
// answered via the normal RAG + local-model path. Images get an explicit
// "not supported" envelope; a document without a text layer gets 422.
// These tests assert the real processing path (extraction → retrieval →
// generation) — never a canned response string.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const documentService = require('../src/services/documentService');
const ollamaService = require('../src/services/ollamaService');
const ragService = require('../src/services/ragService');

const JWT_SECRET = 'nomos-super-secret-key-development';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('pdf body bytes')]);
const DOCX_BUFFER = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('docx body')]);
const PNG_BUFFER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body bytes')
]);

// Default transcript-ish text the shared harness returns; individual tests
// override it per case.
const DEFAULT_EXTRACTED_TEXT = 'Μοκ νομικό κείμενο εγγράφου.';

function enterpriseToken() {
  // Tier (not role) is the gate: a paid enterprise account is role='user'.
  return jwt.sign({ id: 2, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'enterprise',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function postDocument(buffer, filename, token = enterpriseToken()) {
  return request(app)
    .post('/api/ai/multimodal')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', buffer, filename);
}

describe('POST /api/ai/multimodal (real PDF/DOCX handling)', () => {
  afterEach(() => {
    db.query.mockReset();
    documentService.extractMetadata.mockReset();
    documentService.extractMetadata.mockResolvedValue({
      meta: { filename: 'doc.pdf', contentType: 'application/pdf' },
      text: DEFAULT_EXTRACTED_TEXT
    });
    ollamaService.generateResponse.mockClear();
    ragService.retrieveContext.mockClear();
    ragService.formatContextForGemma.mockClear();
    ragService.toSources.mockClear();
    ragService.toSources.mockReturnValue([]);
  });

  it('answers a PDF from its extracted text through RAG + the local model', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    const extracted =
      'Ο μισθωτής υποχρεούται να καταβάλλει το μίσθωμα την πρώτη ημέρα κάθε μήνα.';
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'lease.pdf', contentType: 'application/pdf', page_count: 2 },
      text: extracted
    });
    ragService.toSources.mockReturnValueOnce([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);
    ollamaService.generateResponse.mockResolvedValueOnce(
      'Η σύμβαση μίσθωσης προβλέπει μηνιαίο μίσθωμα.'
    );

    const res = await postDocument(PDF_BUFFER, 'lease.pdf');

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Η σύμβαση μίσθωσης προβλέπει μηνιαίο μίσθωμα.');
    expect(res.body.sources).toEqual([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);

    // Extraction goes through the shared document pipeline, not a re-parse.
    expect(documentService.extractMetadata).toHaveBeenCalledWith(PDF_BUFFER, {
      contentType: 'application/pdf',
      filename: 'lease.pdf'
    });
    // Retrieval is grounded on the document excerpt (default top-K).
    expect(ragService.retrieveContext).toHaveBeenCalledWith(extracted);
    // A real generation call: extracted text inside the prompt + RAG context.
    expect(ollamaService.generateResponse).toHaveBeenCalledTimes(1);
    const [prompt, context] = ollamaService.generateResponse.mock.calls[0];
    expect(context).toBe('Formatted context');
    expect(prompt).toContain(extracted);
    expect(prompt).toMatch(/Περιεχόμενο εγγράφου/);
  });

  it('accepts a DOCX and extracts its text through the same pipeline', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'terms.docx' },
      text: 'Όροι εμπιστευτικότητας της συμφωνίας.'
    });

    const res = await postDocument(DOCX_BUFFER, 'terms.docx');

    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('response');
    expect(documentService.extractMetadata).toHaveBeenCalledWith(DOCX_BUFFER, {
      contentType: DOCX_MIME,
      filename: 'terms.docx'
    });
    expect(ollamaService.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('rejects an image with 415 and the explicit not-supported envelope', async () => {
    queueAuth({ subscription_tier: 'enterprise' });

    const res = await postDocument(PNG_BUFFER, 'screenshot.png');

    expect(res.statusCode).toEqual(415);
    expect(res.body.error).toMatch(/Unsupported media type/);
    expect(documentService.extractMetadata).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('rejects unrecognizable bytes with 400 (matching validateUploadedFile)', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x00, 0x01]);

    const res = await postDocument(binaryGarbage, 'fake.gif');

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
  });

  it('returns 422 for a PDF without a text layer (no model call)', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'scan.pdf', page_count: 4 },
      text: '   \n\t '
    });

    const res = await postDocument(PDF_BUFFER, 'scan.pdf');

    expect(res.statusCode).toEqual(422);
    expect(res.body).toEqual({ error: 'Could not extract text from the document' });
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('caps the excerpt forwarded to retrieval + the model at 8000 characters', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    const capped = 'Α'.repeat(8000);
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'long.pdf' },
      text: `${capped}TAIL`
    });

    const res = await postDocument(PDF_BUFFER, 'long.pdf');

    expect(res.statusCode).toEqual(200);
    expect(ragService.retrieveContext).toHaveBeenCalledWith(capped);
    const [prompt] = ollamaService.generateResponse.mock.calls[0];
    expect(prompt).toContain(capped);
    expect(prompt).not.toContain('TAIL');
  });

  it('surfaces extraction failures as 500', async () => {
    queueAuth({ subscription_tier: 'enterprise' });
    documentService.extractMetadata.mockRejectedValueOnce(new Error('pdf-parse blew up'));

    const res = await postDocument(PDF_BUFFER, 'broken.pdf');

    expect(res.statusCode).toEqual(500);
    expect(res.body.error).toBe('pdf-parse blew up');
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });
});
