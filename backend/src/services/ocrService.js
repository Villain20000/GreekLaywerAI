// Local OCR for image uploads and scanned/textless PDFs (POST /api/ai/multimodal
// and the document ingestion pipeline).
//
// Tesseract.js is required lazily inside the default recognizer so routes and
// tests that never OCR do not pay the WASM/worker startup cost, and so the
// module can be mocked/injected without touching the filesystem. All OCR work
// is serialized (concurrency 1) because a tesseract worker is CPU/RAM heavy;
// OLLAMA/HTTP inference already uses its own queue.

const DEFAULT_LANGUAGES = 'ell+eng';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_PDF_TIMEOUT_MS = 120000;
const DEFAULT_PDF_MAX_CHARS = 200000;

const ERROR_CODES = {
  // Recognition completed but produced no usable text.
  EMPTY: 'OCR_EMPTY',
  // Worker creation/recognition failed (missing traineddata, crash, …).
  FAILED: 'OCR_FAILED',
  // Deadline exceeded; the worker is terminated.
  TIMEOUT: 'OCR_TIMEOUT'
};

/**
 * Typed OCR failure. `status`/`publicMessage` are what the route should put on
 * the wire; `message` is for server logs only (never contains image bytes).
 */
class OcrError extends Error {
  constructor(message, { code, status, publicMessage }) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function getLanguages() {
  const raw = process.env.OCR_LANGUAGES;
  if (typeof raw !== 'string') return DEFAULT_LANGUAGES;
  const languages = raw
    .split('+')
    .map((language) => language.trim())
    .filter(Boolean)
    .join('+');
  return languages || DEFAULT_LANGUAGES;
}

function getTimeoutMs() {
  const parsed = Number(process.env.OCR_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function getPdfTimeoutMs() {
  const parsed = Number(process.env.OCR_PDF_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PDF_TIMEOUT_MS;
}

function emptyError() {
  return new OcrError('OCR returned no text', {
    code: ERROR_CODES.EMPTY,
    status: 422,
    publicMessage: 'Could not extract text from the image'
  });
}

function timeoutError(timeoutMs) {
  return new OcrError(`OCR timed out after ${timeoutMs} ms`, {
    code: ERROR_CODES.TIMEOUT,
    status: 502,
    publicMessage: 'Text recognition timed out for the image'
  });
}

function pdfEmptyError() {
  return new OcrError('OCR returned no text for the PDF', {
    code: ERROR_CODES.EMPTY,
    status: 422,
    publicMessage: 'Could not extract text from the scanned PDF'
  });
}

function pdfTimeoutError(timeoutMs) {
  return new OcrError(`PDF OCR timed out after ${timeoutMs} ms`, {
    code: ERROR_CODES.TIMEOUT,
    status: 502,
    publicMessage: 'Text recognition timed out for the scanned PDF'
  });
}

function pdfFailedError(error) {
  return new OcrError(
    `PDF OCR failed: ${error && error.message ? error.message : 'unknown error'}`,
    {
      code: ERROR_CODES.FAILED,
      status: 502,
      publicMessage: 'Text recognition failed for the scanned PDF'
    }
  );
}

async function terminateWorker(worker) {
  if (!worker || typeof worker.terminate !== 'function') return;
  try {
    await worker.terminate();
  } catch (_) {
    // Best-effort cleanup only.
  }
}

/**
 * Default recognizer: one tesseract worker per call, terminated afterwards.
 * The whole create+recognize operation shares a single deadline; if it fires,
 * the worker is terminated so no background WASM work outlives the request.
 */
async function recognizeWithTesseract(imageBuffer, { languages, timeoutMs }) {
  const { createWorker } = require('tesseract.js');
  let worker = null;
  let timedOut = false;
  let timer = null;

  const work = (async () => {
    worker = await createWorker(languages);
    if (timedOut) {
      await terminateWorker(worker);
      throw timeoutError(timeoutMs);
    }
    const result = await worker.recognize(imageBuffer);
    return result && result.data ? result.data.text : '';
  })();

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Create may still be in flight; `work` terminates it as soon as it
      // resolves. If it already returned, terminate immediately.
      if (worker) {
        Promise.resolve()
          .then(() => terminateWorker(worker))
          .catch(() => {});
      }
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (!timedOut) await terminateWorker(worker);
  }
}

// Serialize OCR runs process-wide (bounded concurrency 1). A rejected task
// must not poison the queue for the next upload.
let ocrQueue = Promise.resolve();

function enqueue(task) {
  const run = ocrQueue.then(task, task);
  ocrQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Bound how long a caller waits, including time spent queued behind a prior
 * recognition. The queued task keeps its place (so concurrency stays 1) and
 * the default recognizer terminates its worker on its own deadline.
 */
function withDeadline(promise, timeoutMs, timeoutFactory = () => timeoutError(timeoutMs)) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutFactory()), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Extract text from an image buffer.
 *
 * @param {Buffer} imageBuffer image bytes (PNG/JPEG/WEBP)
 * @param {{
 *   mimeType?: string,
 *   languages?: string,
 *   timeoutMs?: number,
 *   recognize?: (buffer: Buffer, options: { languages: string, timeoutMs: number }) => Promise<string | { data?: { text?: string } }>
 * }} [options] `recognize` is injectable for tests; the default lazily loads
 *   tesseract.js. An injected recognizer owns its own cancellation.
 * @returns {Promise<string>} trimmed recognized text (never empty)
 * @throws {OcrError} EMPTY (422), FAILED/TIMEOUT (502)
 */
async function extractText(imageBuffer, options = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw emptyError();
  }

  const languages = typeof options.languages === 'string' && options.languages.trim()
    ? options.languages.trim()
    : getLanguages();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : getTimeoutMs();
  const recognize = typeof options.recognize === 'function'
    ? options.recognize
    : recognizeWithTesseract;

  let result;
  try {
    result = await withDeadline(
      enqueue(() => recognize(imageBuffer, { languages, timeoutMs })),
      timeoutMs
    );
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw new OcrError(
      `OCR failed: ${error && error.message ? error.message : 'unknown error'}`,
      {
        code: ERROR_CODES.FAILED,
        status: 502,
        publicMessage: 'Text recognition failed for the image'
      }
    );
  }

  const text = typeof result === 'string'
    ? result
    : result && result.data && typeof result.data.text === 'string'
      ? result.data.text
      : '';
  const trimmed = text.trim();
  if (!trimmed) throw emptyError();
  return trimmed;
}

function normalizeRecognizedText(result) {
  const text = typeof result === 'string'
    ? result
    : result && result.data && typeof result.data.text === 'string'
      ? result.data.text
      : '';
  return text.trim();
}

function normalizeRasterizedPages(rasterized) {
  const entries = Array.isArray(rasterized)
    ? rasterized
    : rasterized && Array.isArray(rasterized.pages)
      ? rasterized.pages
      : [];

  return entries
    .map((entry, index) => {
      if (Buffer.isBuffer(entry)) {
        return { png: entry, pageNumber: index + 1 };
      }
      if (entry && Buffer.isBuffer(entry.png)) {
        const pageNumber = Number.isInteger(entry.pageNumber) && entry.pageNumber > 0
          ? entry.pageNumber
          : index + 1;
        return { png: entry.png, pageNumber };
      }
      return null;
    })
    .filter((entry) => entry && entry.png.length > 0);
}

function defaultRasterize(pdfBuffer, options) {
  // Lazy so mupdf is only imported when a PDF is actually rasterized.
  const { renderPdfPages } = require('./pdfRasterService');
  return renderPdfPages(pdfBuffer, options);
}

/**
 * Extract text from a (possibly scanned) PDF by rasterizing its pages and
 * running the same OCR recognizer used for images.
 *
 * `recognize` and `rasterize` are injectable for tests. The whole operation
 * (queue wait + rasterization + every page recognition) shares one deadline.
 *
 * @param {Buffer} pdfBuffer PDF bytes
 * @param {{
 *   maxPages?: number,
 *   scale?: number,
 *   timeoutMs?: number,
 *   maxChars?: number,
 *   recognize?: Function,
 *   rasterize?: (buffer: Buffer, options: { maxPages?: number, scale?: number }) => Promise<{ pages?: Array<{ png: Buffer, pageNumber?: number }>, } | Buffer[]>
 * }} [options]
 * @returns {Promise<string>} trimmed OCR text with page separators (never empty)
 * @throws {OcrError} EMPTY (422), FAILED/TIMEOUT (502)
 */
async function ocrPdf(pdfBuffer, options = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw pdfEmptyError();
  }

  const languages = typeof options.languages === 'string' && options.languages.trim()
    ? options.languages.trim()
    : getLanguages();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : getPdfTimeoutMs();
  const maxChars = Number.isFinite(Number(options.maxChars)) && Number(options.maxChars) > 0
    ? Math.floor(Number(options.maxChars))
    : DEFAULT_PDF_MAX_CHARS;
  const recognize = typeof options.recognize === 'function'
    ? options.recognize
    : recognizeWithTesseract;
  const rasterize = typeof options.rasterize === 'function'
    ? options.rasterize
    : defaultRasterize;
  const deadlineAt = Date.now() + timeoutMs;

  const work = enqueue(async () => {
    if (Date.now() >= deadlineAt) throw pdfTimeoutError(timeoutMs);

    const rasterized = await rasterize(pdfBuffer, {
      maxPages: options.maxPages,
      scale: options.scale
    });
    const pages = normalizeRasterizedPages(rasterized);
    if (pages.length === 0) throw pdfEmptyError();

    const sections = [];
    let totalChars = 0;
    for (const page of pages) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw pdfTimeoutError(timeoutMs);

      const text = normalizeRecognizedText(
        await recognize(page.png, { languages, timeoutMs: remaining })
      );
      if (!text) continue;

      const label = sections.length > 0 || page.pageNumber > 1
        ? `--- Σελίδα ${page.pageNumber} ---\n\n`
        : '';
      const section = `${label}${text}`;
      sections.push(section);
      totalChars += section.length + (sections.length > 1 ? 2 : 0);
      if (totalChars >= maxChars) break;
    }

    if (sections.length === 0) throw pdfEmptyError();
    const combined = sections.join('\n\n');
    return combined.length > maxChars ? combined.slice(0, maxChars).trimEnd() : combined;
  });

  try {
    return await withDeadline(work, timeoutMs, () => pdfTimeoutError(timeoutMs));
  } catch (error) {
    if (error instanceof OcrError) throw error;
    throw pdfFailedError(error);
  }
}

module.exports = {
  extractText,
  ocrPdf,
  OcrError,
  ERROR_CODES
};
