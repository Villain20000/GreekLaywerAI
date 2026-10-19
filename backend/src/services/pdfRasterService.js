// PDF page rasterization for OCR. mupdf is ESM-only (top-level await), so it
// is imported lazily: normal uploads and tests that never rasterize a PDF do
// not load the WASM bundle.

const DEFAULT_MAX_PAGES = 10;
const DEFAULT_SCALE = 2;

const ERROR_CODES = {
  INVALID: 'PDF_INVALID',
  ENCRYPTED: 'PDF_ENCRYPTED',
  RENDER_FAILED: 'PDF_RENDER_FAILED'
};

class PdfRasterError extends Error {
  constructor(message, { code, publicMessage } = {}) {
    super(message);
    this.name = 'PdfRasterError';
    this.code = code || ERROR_CODES.RENDER_FAILED;
    this.publicMessage = publicMessage || 'Could not render the PDF';
  }
}

function getMaxPages() {
  const parsed = Number(process.env.OCR_PDF_MAX_PAGES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PAGES;
}

function getScale() {
  const parsed = Number(process.env.OCR_PDF_SCALE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCALE;
}

function looksLikePdf(buffer) {
  return buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

function invalidError(message = 'Invalid or empty PDF buffer') {
  return new PdfRasterError(message, {
    code: ERROR_CODES.INVALID,
    publicMessage: 'The PDF file is invalid or could not be opened'
  });
}

function encryptedError(message = 'PDF is encrypted and requires a password') {
  return new PdfRasterError(message, {
    code: ERROR_CODES.ENCRYPTED,
    publicMessage: 'Encrypted PDFs are not supported'
  });
}

function renderError(message) {
  return new PdfRasterError(message, {
    code: ERROR_CODES.RENDER_FAILED,
    publicMessage: 'The PDF pages could not be rendered'
  });
}

function isEncryptionFailure(error) {
  return /encrypt|password|authenticate/i.test(error && error.message ? error.message : '');
}

async function loadMupdf() {
  return import('mupdf');
}

/**
 * Render up to OCR_PDF_MAX_PAGES pages (or `options.maxPages`) at
 * OCR_PDF_SCALE (or `options.scale`) into PNG buffers.
 *
 * `options.loadMupdf` is injectable so tests can avoid the WASM module.
 *
 * @returns {Promise<{ pages: Array<{ pageNumber: number, png: Buffer }>, pageCount: number }>}
 * @throws {PdfRasterError} INVALID, ENCRYPTED or RENDER_FAILED
 */
async function renderPdfPages(pdfBuffer, options = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0 || !looksLikePdf(pdfBuffer)) {
    throw invalidError();
  }

  const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : getMaxPages();
  const scale = Number.isFinite(Number(options.scale)) && Number(options.scale) > 0
    ? Number(options.scale)
    : getScale();
  const loader = typeof options.loadMupdf === 'function' ? options.loadMupdf : loadMupdf;

  let doc = null;
  try {
    let mupdf;
    try {
      mupdf = await loader();
    } catch (error) {
      throw renderError(`Cannot load the PDF renderer: ${error.message}`);
    }

    try {
      doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
    } catch (error) {
      throw isEncryptionFailure(error)
        ? encryptedError(`Cannot open PDF: ${error.message}`)
        : invalidError(`Cannot open PDF: ${error.message}`);
    }

    const encryption = typeof doc.getMetaData === 'function'
      ? doc.getMetaData(mupdf.Document.META_ENCRYPTION || 'encryption')
      : undefined;
    const isEncrypted = typeof encryption === 'string'
      && encryption.length > 0
      && encryption.toLowerCase() !== 'none';
    if ((typeof doc.needsPassword === 'function' && doc.needsPassword()) || isEncrypted) {
      throw encryptedError();
    }

    const pageCount = doc.countPages();
    const renderCount = Math.min(pageCount, maxPages);
    const pages = [];

    for (let i = 0; i < renderCount; i++) {
      let page = null;
      let pixmap = null;
      try {
        page = doc.loadPage(i);
        pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true
        );
        pages.push({ pageNumber: i + 1, png: Buffer.from(pixmap.asPNG()) });
      } catch (error) {
        throw renderError(`Cannot render PDF page ${i + 1}: ${error.message}`);
      } finally {
        if (pixmap && typeof pixmap.destroy === 'function') {
          try { pixmap.destroy(); } catch (_) { /* best-effort */ }
        }
        if (page && typeof page.destroy === 'function') {
          try { page.destroy(); } catch (_) { /* best-effort */ }
        }
      }
    }

    return { pages, pageCount };
  } catch (error) {
    if (error instanceof PdfRasterError) throw error;
    throw renderError(`Cannot render PDF: ${error.message}`);
  } finally {
    if (doc && typeof doc.destroy === 'function') {
      try { doc.destroy(); } catch (_) { /* best-effort */ }
    }
  }
}

module.exports = {
  renderPdfPages,
  PdfRasterError,
  ERROR_CODES
};
