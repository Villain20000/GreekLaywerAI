// Image handling for POST /api/ai/multimodal.
//
// Route-level tests mock the OCR/vision modules (no tesseract worker, no
// Ollama network call); service-level tests exercise the real typed errors and
// the injectable recognizer. PDF/DOCX coverage stays in multimodal.test.js —
// one case here guards that the document branch is unchanged.
process.env.NODE_ENV = 'test';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const documentService = require('../src/services/documentService');
const ollamaService = require('../src/services/ollamaService');
const ragService = require('../src/services/ragService');
const ocrService = require('../src/services/ocrService');
const visionService = require('../src/services/visionService');

const actualOcrService = jest.requireActual('../src/services/ocrService');
const actualVisionService = jest.requireActual('../src/services/visionService');

const mockOllamaChat = jest.fn();
const mockOllamaConstructor = jest.fn(() => ({ chat: mockOllamaChat }));

jest.mock('ollama', () => ({ Ollama: mockOllamaConstructor }));
jest.mock('../src/services/ocrService', () => ({
  ...jest.requireActual('../src/services/ocrService'),
  extractText: jest.fn()
}));
jest.mock('../src/services/visionService', () => ({
  ...jest.requireActual('../src/services/visionService'),
  analyzeImage: jest.fn(),
  isConfigured: jest.fn()
}));

const JWT_SECRET = 'nomos-super-secret-key-development';

const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('pdf body bytes')]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BUFFER = Buffer.concat([PNG_SIGNATURE, Buffer.from('png body bytes')]);
const JPEG_BUFFER = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('jpeg body bytes')
]);
const WEBP_BUFFER = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('webp body bytes')
]);
const GIF_BUFFER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x00]);

const OCR_TEXT = 'Ο μισθωτής υποχρεούται να καταβάλλει το μίσθωμα.';
const DEFAULT_EXTRACTED_TEXT = 'Μοκ νομικό κείμενο εγγράφου.';

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

describe('POST /api/ai/multimodal (images)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    visionService.isConfigured.mockReturnValue(false);
    visionService.analyzeImage.mockResolvedValue('Απάντηση από το μοντέλο όρασης.');
    ocrService.extractText.mockResolvedValue(OCR_TEXT);
    documentService.extractMetadata.mockResolvedValue({
      meta: { filename: 'doc.pdf', contentType: 'application/pdf' },
      text: DEFAULT_EXTRACTED_TEXT
    });
    ragService.retrieveContext.mockResolvedValue([{ content: 'Mock context', similarity: 0.8 }]);
    ragService.formatContextForGemma.mockReturnValue('Formatted context');
    ragService.toSources.mockReturnValue([]);
    ragService.calculateConfidence.mockReturnValue(0);
    ollamaService.generateResponse.mockResolvedValue('Mock response');
  });

  afterEach(() => {
    db.query.mockReset();
    mockOllamaChat.mockReset();
    mockOllamaConstructor.mockClear();
  });

  it('OCRs a PNG and answers through RAG + the local model', async () => {
    queueAuth();
    ragService.toSources.mockReturnValueOnce([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);
    ollamaService.generateResponse.mockResolvedValueOnce('Η σύμβαση προβλέπει μηνιαίο μίσθωμα.');

    const res = await postFile(PNG_BUFFER, 'scan.png');

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Η σύμβαση προβλέπει μηνιαίο μίσθωμα.');
    expect(res.body.sources).toEqual([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);
    expect(res.body.confidence).toBe(0);

    expect(ocrService.extractText).toHaveBeenCalledWith(PNG_BUFFER, { mimeType: 'image/png' });
    expect(visionService.analyzeImage).not.toHaveBeenCalled();
    expect(documentService.extractMetadata).not.toHaveBeenCalled();
    expect(ragService.retrieveContext).toHaveBeenCalledWith(OCR_TEXT);

    const [prompt, context] = ollamaService.generateResponse.mock.calls[0];
    expect(context).toBe('Formatted context');
    expect(prompt).toContain(OCR_TEXT);
    expect(prompt).toMatch(/Κείμενο από OCR/);
  });

  it('accepts WEBP images through the same OCR path', async () => {
    queueAuth();

    const res = await postFile(WEBP_BUFFER, 'contract.webp');

    expect(res.statusCode).toEqual(200);
    expect(ocrService.extractText).toHaveBeenCalledWith(WEBP_BUFFER, { mimeType: 'image/webp' });
  });

  it('uses the configured vision model first and grounds it with RAG context', async () => {
    queueAuth();
    visionService.isConfigured.mockReturnValue(true);
    visionService.analyzeImage.mockResolvedValueOnce('Προσοχή στους όρους καταγγελίας.');
    ragService.toSources.mockReturnValueOnce([{ type: 'legislation', id: 9, title: 'ΑΚ 588' }]);

    const res = await postFile(JPEG_BUFFER, 'lease.jpg');

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Προσοχή στους όρους καταγγελίας.');
    expect(res.body.sources).toEqual([{ type: 'legislation', id: 9, title: 'ΑΚ 588' }]);
    expect(ocrService.extractText).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();

    const [buffer, options] = visionService.analyzeImage.mock.calls[0];
    expect(buffer).toEqual(JPEG_BUFFER);
    expect(options).toMatchObject({
      mimeType: 'image/jpeg',
      context: 'Formatted context'
    });
    expect(options.prompt).toMatch(/Ανέλυσε την ακόλουθη εικόνα/);
    expect(JSON.stringify(res.body)).not.toContain(JPEG_BUFFER.toString('base64'));
  });

  it('falls back to OCR when vision fails', async () => {
    queueAuth();
    visionService.isConfigured.mockReturnValue(true);
    visionService.analyzeImage.mockRejectedValueOnce(
      new visionService.VisionError('ollama is down', {
        code: visionService.ERROR_CODES.UNAVAILABLE,
        status: 502,
        publicMessage: 'Image analysis is temporarily unavailable'
      })
    );
    ollamaService.generateResponse.mockResolvedValueOnce('Ανάλυση μέσω OCR.');

    const res = await postFile(PNG_BUFFER, 'scan.png');

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Ανάλυση μέσω OCR.');
    expect(ocrService.extractText).toHaveBeenCalledTimes(1);
    expect(ollamaService.generateResponse).toHaveBeenCalledTimes(1);
    // Retrieval is re-run against the OCR text for the fallback answer.
    expect(ragService.retrieveContext).toHaveBeenLastCalledWith(OCR_TEXT);
  });

  it('returns 422 when OCR produces no text', async () => {
    queueAuth();
    ocrService.extractText.mockRejectedValueOnce(
      new actualOcrService.OcrError('OCR returned no text', {
        code: actualOcrService.ERROR_CODES.EMPTY,
        status: 422,
        publicMessage: 'Could not extract text from the image'
      })
    );

    const res = await postFile(PNG_BUFFER, 'blank.png');

    expect(res.statusCode).toEqual(422);
    expect(res.body).toEqual({ error: 'Could not extract text from the image' });
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns 502 when OCR fails', async () => {
    queueAuth();
    ocrService.extractText.mockRejectedValueOnce(
      new actualOcrService.OcrError('tesseract worker crashed', {
        code: actualOcrService.ERROR_CODES.FAILED,
        status: 502,
        publicMessage: 'Text recognition failed for the image'
      })
    );

    const res = await postFile(PNG_BUFFER, 'broken.png');

    expect(res.statusCode).toEqual(502);
    expect(res.body).toEqual({ error: 'Text recognition failed for the image' });
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });

  it('rejects images larger than 5 MB with 413 before OCR/vision', async () => {
    queueAuth();
    const oversized = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(5 * 1024 * 1024)]);

    const res = await postFile(oversized, 'huge.png');

    expect(res.statusCode).toEqual(413);
    expect(res.body.error).toMatch(/5 MB/);
    expect(ocrService.extractText).not.toHaveBeenCalled();
    expect(visionService.analyzeImage).not.toHaveBeenCalled();
  });

  it('rejects unrecognizable binary uploads with 400', async () => {
    queueAuth();

    const res = await postFile(GIF_BUFFER, 'fake.gif');

    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
    expect(ocrService.extractText).not.toHaveBeenCalled();
    expect(visionService.analyzeImage).not.toHaveBeenCalled();
  });

  it('keeps the PDF extraction path unchanged', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'lease.pdf', contentType: 'application/pdf' },
      text: 'Ο μισθωτής οφείλει το μίσθωμα την πρώτη ημέρα.'
    });
    ragService.toSources.mockReturnValueOnce([{ type: 'legislation', id: 7, title: 'ΑΚ 574' }]);
    ollamaService.generateResponse.mockResolvedValueOnce('Ανάλυση εγγράφου.');

    const res = await postFile(PDF_BUFFER, 'lease.pdf');

    expect(res.statusCode).toEqual(200);
    expect(res.body.response).toBe('Ανάλυση εγγράφου.');
    expect(documentService.extractMetadata).toHaveBeenCalledWith(PDF_BUFFER, {
      contentType: 'application/pdf',
      filename: 'lease.pdf'
    });
    expect(ocrService.extractText).not.toHaveBeenCalled();
    expect(visionService.analyzeImage).not.toHaveBeenCalled();
    const [prompt] = ollamaService.generateResponse.mock.calls[0];
    expect(prompt).toMatch(/Περιεχόμενο εγγράφου/);
  });

  it('keeps textless PDFs at 422 and explains that OCR is unavailable', async () => {
    queueAuth();
    documentService.extractMetadata.mockResolvedValueOnce({
      meta: { filename: 'scan.pdf', page_count: 4 },
      text: '   \n\t '
    });

    const res = await postFile(PDF_BUFFER, 'scan.pdf');

    expect(res.statusCode).toEqual(422);
    expect(res.body.error).toMatch(/Could not extract text from the document/);
    expect(res.body.error).toMatch(/OCR is not available for scanned PDFs/);
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(ollamaService.generateResponse).not.toHaveBeenCalled();
  });
});

describe('ocrService.extractText', () => {
  const originalLanguages = process.env.OCR_LANGUAGES;

  beforeEach(() => {
    process.env.OCR_LANGUAGES = 'ell+eng';
  });

  afterEach(() => {
    if (originalLanguages === undefined) delete process.env.OCR_LANGUAGES;
    else process.env.OCR_LANGUAGES = originalLanguages;
  });

  it('uses an injected recognizer and trims its text', async () => {
    const recognize = jest.fn().mockResolvedValue('  Αναγνωρισμένο κείμενο  ');

    await expect(actualOcrService.extractText(PNG_BUFFER, { recognize })).resolves.toBe(
      'Αναγνωρισμένο κείμενο'
    );
    expect(recognize).toHaveBeenCalledWith(
      PNG_BUFFER,
      expect.objectContaining({ languages: expect.stringContaining('ell') })
    );
  });

  it('throws a typed 422 error for empty OCR output', async () => {
    const recognize = jest.fn().mockResolvedValue('   ');

    await expect(actualOcrService.extractText(PNG_BUFFER, { recognize })).rejects.toMatchObject({
      name: 'OcrError',
      code: actualOcrService.ERROR_CODES.EMPTY,
      status: 422,
      publicMessage: 'Could not extract text from the image'
    });
  });

  it('throws a typed 502 error when recognition fails', async () => {
    const recognize = jest.fn().mockRejectedValue(new Error('worker crashed'));

    await expect(actualOcrService.extractText(PNG_BUFFER, { recognize })).rejects.toMatchObject({
      name: 'OcrError',
      code: actualOcrService.ERROR_CODES.FAILED,
      status: 502
    });
  });

  it('serializes concurrent recognition to concurrency 1', async () => {
    let active = 0;
    let maxActive = 0;
    const recognize = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 'Κείμενο';
    });

    await Promise.all([
      actualOcrService.extractText(PNG_BUFFER, { recognize }),
      actualOcrService.extractText(JPEG_BUFFER, { recognize })
    ]);

    expect(maxActive).toBe(1);
  });

  it('bounds a slow recognition with a typed 502 timeout', async () => {
    const recognize = jest.fn(
      () => new Promise((resolve) => setTimeout(() => resolve('too late'), 200))
    );

    await expect(
      actualOcrService.extractText(PNG_BUFFER, { recognize, timeoutMs: 20 })
    ).rejects.toMatchObject({
      name: 'OcrError',
      code: actualOcrService.ERROR_CODES.TIMEOUT,
      status: 502
    });
  });
});

describe('visionService.analyzeImage', () => {
  const originalVisionModel = process.env.OLLAMA_VISION_MODEL;

  afterEach(() => {
    if (originalVisionModel === undefined) delete process.env.OLLAMA_VISION_MODEL;
    else process.env.OLLAMA_VISION_MODEL = originalVisionModel;
    mockOllamaChat.mockReset();
    mockOllamaConstructor.mockClear();
  });

  it('is disabled when OLLAMA_VISION_MODEL is unset', async () => {
    delete process.env.OLLAMA_VISION_MODEL;
    expect(actualVisionService.isConfigured()).toBe(false);
    await expect(actualVisionService.analyzeImage(PNG_BUFFER)).rejects.toMatchObject({
      name: 'VisionError',
      code: actualVisionService.ERROR_CODES.NOT_CONFIGURED
    });
    expect(mockOllamaChat).not.toHaveBeenCalled();
  });

  it('sends the base64 image and Greek prompt to the configured model', async () => {
    process.env.OLLAMA_VISION_MODEL = 'llava';
    mockOllamaChat.mockResolvedValueOnce({ message: { content: '  Νομική ανάλυση εικόνας  ' } });

    const answer = await actualVisionService.analyzeImage(PNG_BUFFER, {
      mimeType: 'image/png',
      prompt: 'Ανέλυσε την εικόνα.',
      context: 'Νομοθετικό πλαίσιο.'
    });

    expect(answer).toBe('Νομική ανάλυση εικόνας');
    expect(mockOllamaConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ host: expect.any(String), fetch: expect.any(Function) })
    );
    const request = mockOllamaChat.mock.calls[0][0];
    expect(request.model).toBe('llava');
    expect(request.stream).toBe(false);
    expect(request.messages[1].images).toEqual([PNG_BUFFER.toString('base64')]);
    expect(request.messages[1].content).toContain('Σχετική νομοθεσία');
    expect(request.messages[1].content).toContain('Ανέλυσε την εικόνα.');
  });

  it('throws a typed error when the model returns no text', async () => {
    process.env.OLLAMA_VISION_MODEL = 'llava';
    mockOllamaChat.mockResolvedValueOnce({ message: { content: '   ' } });

    await expect(actualVisionService.analyzeImage(PNG_BUFFER, { prompt: 'x' })).rejects.toMatchObject({
      name: 'VisionError',
      code: actualVisionService.ERROR_CODES.EMPTY_RESPONSE
    });
  });
});
