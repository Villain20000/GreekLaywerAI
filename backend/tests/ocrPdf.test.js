// OCR for scanned/textless PDFs: rasterization, page OCR, document uploads
// and the multimodal route. No mupdf binary, tesseract worker, network or
// real PDF file is used — rasterization is driven by an injected fake mupdf.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const documentService = require('../src/services/documentService');
const actualDocumentService = jest.requireActual('../src/services/documentService');
const ollamaService = require('../src/services/ollamaService');
const ragService = require('../src/services/ragService');
const ocrService = require('../src/services/ocrService');
const pdfRasterService = require('../src/services/pdfRasterService');
const pdfParse = require('pdf-parse');

const actualOcrService = jest.requireActual('../src/services/ocrService');

jest.mock('pdf-parse', () => jest.fn());
jest.mock('../src/services/ocrService', () => ({
  ...jest.requireActual('../src/services/ocrService'),
  ocrPdf: jest.fn()
}));

const JWT_SECRET = 'nomos-super-secret-key-development';
const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('mock pdf body')]);

function enterpriseToken() {
  return jwt.sign({ id: 2, email: 'user@nomos.ai', role: 'user', tv: 1 }, JWT_SECRET);
}

function queueAuth() {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: 2,
      email: 'user@nomos.ai',
      role: 'user',
      subscription_tier: 'enterprise',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function postFile(buffer, filename) {
  return request(app)
    .post('/api/ai/multimodal')
    .set('Authorization', `Bearer ${enterpriseToken()}`)
    .attach('file', buffer, filename);
}

function makeFakeMupdf(pageCount, { encrypted = false } = {}) {
  const renderedPages = [];
  const pixmaps = [];
  const doc = {
    needsPassword: jest.fn(() => encrypted),
    getMetaData: jest.fn(() => 'None'),
    countPages: jest.fn(() => pageCount),
    loadPage: jest.fn((index) => {
      const pixmap = {
        asPNG: jest.fn(() => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, index])),
        destroy: jest.fn()
      };
      const page = {
        toPixmap: jest.fn(() => pixmap),
        destroy: jest.fn()
      };
      renderedPages.push(page);
      pixmaps.push(pixmap);
      return page;
    }),
    destroy: jest.fn()
  };
  const mupdf = {
    Document: {
      openDocument: jest.fn(() => doc),
      META_ENCRYPTION: 'encryption'
    },
    Matrix: { scale: jest.fn((sx, sy) => ({ sx, sy })) },
    ColorSpace: { DeviceRGB: { deviceRgb: true } }
  };
  return { mupdf, doc, renderedPages, pixmaps, openDocument: mupdf.Document.openDocument };
}

function makeClient() {
  return {
    query: jest.fn(async (sql) => {
      const statement = String(sql).trim();
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (statement.startsWith('INSERT INTO legal_documents')) {
        return {
          rows: [{
            id: 11,
            user_id: 2,
            filename: 'scan.pdf',
            title: null,
            content_type: 'application/pdf',
            metadata: {},
            file_size: PDF_BUFFER.length,
            created_at: '2026-01-01T00:00:00Z'
          }],
          rowCount: 1
        };
      }
      if (statement.startsWith('INSERT INTO legal_document_chunks')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn()
  };
}

function findCall(client, prefix) {
  return client.query.mock.calls.find(([sql]) => String(sql).trim().startsWith(prefix));
}

describe('pdfRasterService.renderPdfPages', () => {
  const originalMaxPages = process.env.OCR_PDF_MAX_PAGES;
  const originalScale = process.env.OCR_PDF_SCALE;

  afterEach(() => {
    if (originalMaxPages === undefined) delete process.env.OCR_PDF_MAX_PAGES;
    else process.env.OCR_PDF_MAX_PAGES = originalMaxPages;
    if (originalScale === undefined) delete process.env.OCR_PDF_SCALE;
    else process.env.OCR_PDF_SCALE = originalScale;
  });

  it('renders at most maxPages pages at the requested scale and cleans up', async () => {
    const fake = makeFakeMupdf(25);

    const result = await pdfRasterService.renderPdfPages(PDF_BUFFER, {
      maxPages: 3,
      scale: 2,
      loadMupdf: async () => fake.mupdf
    });

    expect(result.pageCount).toBe(25);
    expect(result.pages).toHaveLength(3);
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(Buffer.isBuffer(result.pages[0].png)).toBe(true);

    expect(fake.openDocument).toHaveBeenCalledWith(PDF_BUFFER, 'application/pdf');
    expect(fake.mupdf.Matrix.scale).toHaveBeenCalledWith(2, 2);
    expect(fake.doc.loadPage.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
    fake.renderedPages.forEach((page) => {
      expect(page.toPixmap).toHaveBeenCalledWith(
        expect.anything(),
        fake.mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );
      expect(page.destroy).toHaveBeenCalledTimes(1);
    });
    fake.pixmaps.forEach((pixmap) => {
      expect(pixmap.destroy).toHaveBeenCalledTimes(1);
    });
    expect(fake.doc.destroy).toHaveBeenCalledTimes(1);
  });

  it('reads OCR_PDF_MAX_PAGES and OCR_PDF_SCALE from the environment', async () => {
    process.env.OCR_PDF_MAX_PAGES = '2';
    process.env.OCR_PDF_SCALE = '1.5';
    const fake = makeFakeMupdf(5);

    const result = await pdfRasterService.renderPdfPages(PDF_BUFFER, {
      loadMupdf: async () => fake.mupdf
    });

    expect(result.pages).toHaveLength(2);
    expect(fake.mupdf.Matrix.scale).toHaveBeenCalledWith(1.5, 1.5);
  });

  it('throws a typed PDF_INVALID error for malformed bytes without loading mupdf', async () => {
    const loadMupdf = jest.fn();

    await expect(
      pdfRasterService.renderPdfPages(Buffer.from('not a pdf'), { loadMupdf })
    ).rejects.toMatchObject({
      name: 'PdfRasterError',
      code: pdfRasterService.ERROR_CODES.INVALID
    });
    expect(loadMupdf).not.toHaveBeenCalled();
  });

  it('throws a typed PDF_ENCRYPTED error and still closes the document', async () => {
    const fake = makeFakeMupdf(2, { encrypted: true });

    await expect(
      pdfRasterService.renderPdfPages(PDF_BUFFER, { loadMupdf: async () => fake.mupdf })
    ).rejects.toMatchObject({
      name: 'PdfRasterError',
      code: pdfRasterService.ERROR_CODES.ENCRYPTED
    });
    expect(fake.doc.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('ocrService.ocrPdf', () => {
  it('rasterizes and concatenates per-page OCR text with page separators', async () => {
    const firstPage = Buffer.from('png-page-1');
    const secondPage = Buffer.from('png-page-2');
    const rasterize = jest.fn().mockResolvedValue({
      pages: [
        { pageNumber: 1, png: firstPage },
        { pageNumber: 2, png: secondPage }
      ],
      pageCount: 2
    });
    const recognize = jest.fn(async (buffer) =>
      buffer === firstPage ? '  Πρώτη σελίδα.  ' : 'Δεύτερη σελίδα.'
    );

    const text = await actualOcrService.ocrPdf(PDF_BUFFER, {
      maxPages: 2,
      languages: 'ell+eng',
      rasterize,
      recognize
    });

    expect(text).toBe('Πρώτη σελίδα.\n\n--- Σελίδα 2 ---\n\nΔεύτερη σελίδα.');
    expect(rasterize).toHaveBeenCalledWith(
      PDF_BUFFER,
      expect.objectContaining({ maxPages: 2 })
    );
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognize).toHaveBeenNthCalledWith(
      1,
      firstPage,
      expect.objectContaining({ languages: 'ell+eng', timeoutMs: expect.any(Number) })
    );
  });

  it('throws a typed 422 when every page is blank', async () => {
    const rasterize = jest.fn().mockResolvedValue({
      pages: [{ pageNumber: 1, png: Buffer.from('png-page') }]
    });
    const recognize = jest.fn().mockResolvedValue('   ');

    await expect(
      actualOcrService.ocrPdf(PDF_BUFFER, { rasterize, recognize })
    ).rejects.toMatchObject({
      name: 'OcrError',
      code: actualOcrService.ERROR_CODES.EMPTY,
      status: 422
    });
  });

  it('caps the total OCR output', async () => {
    const rasterize = jest.fn().mockResolvedValue({
      pages: [
        { pageNumber: 1, png: Buffer.from('png-page-1') },
        { pageNumber: 2, png: Buffer.from('png-page-2') }
      ]
    });
    const recognize = jest.fn().mockResolvedValue('Α'.repeat(50));

    const text = await actualOcrService.ocrPdf(PDF_BUFFER, {
      maxChars: 40,
      rasterize,
      recognize
    });

    expect(text.length).toBeLessThanOrEqual(40);
  });
});

describe('documentService.processAndStoreDocument (scanned PDFs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    db.connect.mockReset();
    pdfParse.mockReset();
    ocrService.ocrPdf.mockReset();
    ollamaService.generateEmbedding.mockReset();
    ollamaService.generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('stores OCR text, ocr metadata and embeddings for a textless PDF', async () => {
    pdfParse.mockResolvedValueOnce({ text: '', numpages: 3, info: {} });
    ocrService.ocrPdf.mockResolvedValueOnce('Κείμενο από σαρωμένο PDF.');
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    const { document, chunkCount } = await actualDocumentService.processAndStoreDocument(
      2,
      { buffer: PDF_BUFFER, originalname: 'scan.pdf' },
      'application/pdf',
      null
    );

    expect(document.id).toBe(11);
    expect(chunkCount).toBe(1);
    expect(ocrService.ocrPdf).toHaveBeenCalledWith(PDF_BUFFER);

    const [, params] = findCall(client, 'INSERT INTO legal_documents');
    expect(params[5]).toBe('Κείμενο από σαρωμένο PDF.');
    const metadata = JSON.parse(params[6]);
    expect(metadata.ocr_applied).toBe(true);
    expect(metadata.page_count).toBe(3);
    expect(metadata.char_count).toBe('Κείμενο από σαρωμένο PDF.'.length);

    expect(ollamaService.generateEmbedding).toHaveBeenCalledWith('Κείμενο από σαρωμένο PDF.');
    const chunkCalls = client.query.mock.calls.filter(
      ([sql]) => String(sql).trim().startsWith('INSERT INTO legal_document_chunks')
    );
    expect(chunkCalls).toHaveLength(1);
    expect(chunkCalls[0][1][1]).toBe('Κείμενο από σαρωμένο PDF.');
  });

  it('never OCRs a PDF that already has a text layer', async () => {
    pdfParse.mockResolvedValueOnce({
      text: 'Κανονικό κείμενο PDF.',
      numpages: 1,
      info: {}
    });
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    await actualDocumentService.processAndStoreDocument(
      2,
      { buffer: PDF_BUFFER, originalname: 'normal.pdf' },
      'application/pdf',
      null
    );

    expect(ocrService.ocrPdf).not.toHaveBeenCalled();
    const [, params] = findCall(client, 'INSERT INTO legal_documents');
    expect(params[5]).toBe('Κανονικό κείμενο PDF.');
    expect(JSON.parse(params[6]).ocr_applied).toBeUndefined();
  });

  it('never OCRs non-PDF uploads', async () => {
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    const { chunkCount } = await actualDocumentService.processAndStoreDocument(
      2,
      { buffer: Buffer.from('   '), originalname: 'blank.txt' },
      'text/plain',
      null
    );

    expect(chunkCount).toBe(0);
    expect(pdfParse).not.toHaveBeenCalled();
    expect(ocrService.ocrPdf).not.toHaveBeenCalled();
  });

  it('keeps the upload successful when OCR fails (empty parsed_text, no embeddings)', async () => {
    pdfParse.mockResolvedValueOnce({ text: ' \n ', numpages: 2, info: {} });
    ocrService.ocrPdf.mockRejectedValueOnce(
      new actualOcrService.OcrError('tesseract crashed', {
        code: actualOcrService.ERROR_CODES.FAILED,
        status: 502,
        publicMessage: 'Text recognition failed for the scanned PDF'
      })
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = makeClient();
    db.connect.mockResolvedValueOnce(client);

    try {
      const { chunkCount } = await actualDocumentService.processAndStoreDocument(
        2,
        { buffer: PDF_BUFFER, originalname: 'broken-scan.pdf' },
        'application/pdf',
        null
      );

      expect(chunkCount).toBe(0);
      expect(ocrService.ocrPdf).toHaveBeenCalledTimes(1);
      expect(ollamaService.generateEmbedding).not.toHaveBeenCalled();

      const [, params] = findCall(client, 'INSERT INTO legal_documents');
      expect(params[5]).toBeNull();
      const metadata = JSON.parse(params[6]);
      expect(metadata.ocr_applied).toBeUndefined();
      expect(metadata.char_count).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OCR failed'));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('POST /api/ai/multimodal (scanned PDFs)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    documentService.extractMetadata.mockReset();
    ocrService.ocrPdf.mockReset();
    ragService.retrieveContext.mockReset();
    ragService.retrieveContext.mockResolvedValue([{ content: 'Mock context', similarity: 0.8 }]);
    ragService.formatContextForGemma.mockReturnValue('Formatted context');
    ragService.toSources.mockReturnValue([]);
    ragService.calculateConfidence.mockReturnValue(0);
    ollamaService.generateResponse.mockReset();
    ollamaService.generateResponse.mockResolvedValue('Mock response');
  });

  it('OCRs a textless PDF and answers through RAG + the local model', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'scan.pdf', contentType: 'application/pdf', page_count: 3 },
      text: '   \n\t '
    });
    ocrService.ocrPdf.mockResolvedValueOnce('Κείμενο από σαρωμένο PDF.');
    ragService.toSources.mockReturnValueOnce([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);
    ollamaService.generateResponse.mockResolvedValueOnce('Η ανάλυση του σαρωμένου PDF.');

    const res = await postFile(PDF_BUFFER, 'scan.pdf');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      response: 'Η ανάλυση του σαρωμένου PDF.',
      sources: [{ type: 'legislation', id: 7, title: 'ΑΚ 574' }],
      confidence: 0
    });
    expect(ocrService.ocrPdf).toHaveBeenCalledWith(PDF_BUFFER);
    expect(ragService.retrieveContext).toHaveBeenCalledWith('Κείμενο από σαρωμένο PDF.');

    const [prompt, context] = ollamaService.generateResponse.mock.calls[0];
    expect(context).toBe('Formatted context');
    expect(prompt).toContain('Κείμενο από σαρωμένο PDF.');
    expect(prompt).toMatch(/Περιεχόμενο εγγράφου/);
  });

  it('returns 422 when OCR finds no readable text in the scanned PDF', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'blank.pdf', contentType: 'application/pdf', page_count: 2 },
      text: ' \n '
    });
    ocrService.ocrPdf.mockRejectedValueOnce(
      new actualOcrService.OcrError('OCR returned no text', {
        code: actualOcrService.ERROR_CODES.EMPTY,
        status: 422,
        publicMessage: 'Could not extract text from the scanned PDF'
      })
    );

    const res = await postFile(PDF_BUFFER, 'blank.pdf');

    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatch(/OCR did not find readable text/);
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns 422 without calling the model when PDF OCR fails', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'encrypted.pdf', contentType: 'application/pdf' },
      text: ''
    });
    ocrService.ocrPdf.mockRejectedValueOnce(
      new actualOcrService.OcrError('PDF is encrypted', {
        code: actualOcrService.ERROR_CODES.FAILED,
        status: 502,
        publicMessage: 'Text recognition failed for the scanned PDF'
      })
    );

    const res = await postFile(PDF_BUFFER, 'encrypted.pdf');

    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatch(/Could not extract text from the document/);
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('does not OCR a PDF that already has a text layer', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'normal.pdf', contentType: 'application/pdf', page_count: 1 },
      text: 'Κανονικό κείμενο PDF.'
    });
    ollamaService.generateResponse.mockResolvedValueOnce('Ανάλυση κανονικού PDF.');

    const res = await postFile(PDF_BUFFER, 'normal.pdf');

    expect(res.statusCode).toBe(200);
    expect(ocrService.ocrPdf).not.toHaveBeenCalled();
    expect(ragService.retrieveContext).toHaveBeenCalledWith('Κανονικό κείμενο PDF.');
    expect(ollamaService.generateResponse).toHaveBeenCalledTimes(1);
  });
});
