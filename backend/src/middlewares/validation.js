// Phase 29: Composable input-validation middleware built on express-validator.
//
// Usage:
//   router.post('/x', validate([check('prompt').isString().notEmpty()]), handler)
//
// On failure: 400 with `{ error, details }` listing every failed field. No
// handler code (and therefore no DB calls) runs for invalid input.

const { validationResult } = require('express-validator');

/**
 * Wrap express-validator chains: run them, then 400 on any failure.
 */
function validate(chains = []) {
  return async (req, res, next) => {
    await Promise.all(chains.map((chain) => chain.run(req)));
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    return res.status(400).json({
      error: 'Invalid input',
      details: errors.array().map((e) => ({
        field: e.path,
        message: e.msg
      }))
    });
  };
}

/**
 * Magic-byte (content sniffing) file validation, dependency-free.
 * Returns the detected type or null. Mirrors `file-type`'s core checks
 * for the formats NomosAI accepts.
 */
function sniffFileType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = (offset) => buffer[offset];

  // PDF: %PDF
  if (buffer.length >= 4 && b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) {
    return 'application/pdf';
  }
  // PNG: \x89PNG\r\n\x1a\n
  if (
    buffer.length >= 8 &&
    b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47 &&
    b(4) === 0x0d && b(5) === 0x0a && b(6) === 0x1a && b(7) === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) {
    return 'image/jpeg';
  }
  // WebM: 0x1A 0x45 0xDF 0xA3 (EBML header; also covers Matroska)
  if (b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3) {
    return 'audio/webm';
  }
  // WAV: RIFF....WAVE
  if (
    buffer.length >= 12 &&
    b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 &&
    b(8) === 0x57 && b(9) === 0x41 && b(10) === 0x56 && b(11) === 0x45
  ) {
    return 'audio/wav';
  }
  // MP4: ftyp box at offset 4 (audio/mp4, video/mp4)
  if (buffer.length >= 12 && b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
    return 'audio/mp4';
  }
  // DOCX / OOXML: PK\x03\x04 (zip container)
  if (buffer.length >= 4 && b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  // Plain text: printable ASCII / UTF-8-ish heuristic
  if (buffer.length >= 4) {
    let printable = 0;
    const probe = Math.min(buffer.length, 256);
    for (let i = 0; i < probe; i++) {
      const byte = b(i);
      if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc0) {
        printable++;
      }
    }
    if (printable / probe > 0.9) return 'text/plain';
  }
  return null;
}

const ALLOWED_FILE_TYPES = {
  audio: ['audio/webm', 'audio/wav', 'audio/mp4'],
  image: ['image/png', 'image/jpeg'],
  document: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ],
  // /api/ai/multimodal accepts PDFs + images only (plan: pdf/png/jpeg).
  multimodal: ['application/pdf', 'image/png', 'image/jpeg']
};

/**
 * Validate an uploaded file (multer single) by magic bytes, not extension.
 * @param {string} kind one of 'audio' | 'image' | 'document'
 */
function validateUploadedFile(kind) {
  return (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const sniffed = sniffFileType(req.file.buffer);
    const allowed = ALLOWED_FILE_TYPES[kind] || [];
    if (!sniffed || !allowed.includes(sniffed)) {
      return res.status(400).json({
        error: `Unsupported file type. Allowed: ${allowed.join(', ')}`
      });
    }
    // Sanitize: strip any path components from the original filename so a
    // crafted multipart name can't traverse directories on download routes.
    if (req.file.originalname) {
      req.file.originalname = req.file.originalname.replace(/[\\/]/g, '_');
    }
    req.file.detectedType = sniffed;
    next();
  };
}

module.exports = { validate, sniffFileType, validateUploadedFile, ALLOWED_FILE_TYPES };
