// Phase 29: Legal Documents CRUD API.
//
// - POST   /api/documents            upload (multipart: file + optional title)
// - GET    /api/documents            list user's documents (metadata only)
// - GET    /api/documents/:id        document details (+ chunk count)
// - GET    /api/documents/:id/content  download original text
// - DELETE /api/documents/:id        delete document + chunks
// - POST   /api/documents/search     vector similarity search (user's docs)
//
// File types are validated by magic bytes (not extension). All queries are
// scoped to req.user.id.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../config/db');
const documentService = require('../services/documentService');
const { validate, validateUploadedFile } = require('../middlewares/validation');
const { check } = require('express-validator');
const { logAudit } = require('../services/auditLog');
const { createApiRateLimiters } = require('../middlewares/rateLimiters');
const { enforceDocumentCap } = require('../middlewares/quotaMiddleware');

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB, matches plan

// 1-3: per-user caps. documentUpload sits BEFORE multer so a throttled
// caller never gets its 25MB body buffered into memory.
const limiters = createApiRateLimiters();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

function parsePositiveInt(raw) {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Download filenames must not be able to break or inject headers: strip
// CR/LF, control chars and path separators before using them.
function sanitizeDownloadFilename(raw, fallback) {
  const cleaned = String(raw || '')
    .replace(/[\r\n]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned || fallback;
}

// ASCII fallback for legacy clients + RFC 5987 filename* so Greek
// filenames survive intact.
function attachmentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// POST /api/documents — upload + process (extract → chunk → embed)
router.post(
  '/',
  limiters.documentUpload,
  enforceDocumentCap,
  upload.single('file'),
  validate([check('title').optional({ values: 'null' }).isString().isLength({ max: 255 })]),
  validateUploadedFile('document'),
  async (req, res) => {
    try {
      const { document, chunkCount } = await documentService.processAndStoreDocument(
        req.user.id,
        req.file,
        req.file.detectedType,
        req.body && req.body.title
      );
      res.status(201).json({ document, chunkCount });
    } catch (error) {
      console.error('Document upload error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// GET /api/documents — list user's documents (paginated, no parsed_text)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const result = await db.query(
      `SELECT id, filename, title, content_type, metadata, file_size, created_at
       FROM legal_documents
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ documents: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id — details (with chunk count, without parsed_text)
router.get('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid document id' });

    const result = await db.query(
      `SELECT d.id, d.filename, d.title, d.content_type, d.metadata, d.file_size, d.created_at,
              (SELECT COUNT(*) FROM legal_document_chunks c WHERE c.document_id = d.id) AS chunk_count
       FROM legal_documents d
       WHERE d.id = $1 AND d.user_id = $2`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ document: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:id/content — original file, or extracted text
// (?format=text). Legacy rows without original_file fall back to text.
router.get('/:id/content', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid document id' });

    // Text previews must not pull a 25 MB BYTEA into memory.
    const withOriginal = req.query.format !== 'text';
    const result = await db.query(
      `SELECT id, filename, content_type, parsed_text${withOriginal ? ', original_file' : ''}
       FROM legal_documents
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const doc = result.rows[0];
    res.setHeader('Cache-Control', 'no-store');

    // Explicit text preview, or a legacy row uploaded before original bytes
    // were persisted: keep the historical .txt attachment behavior.
    if (req.query.format === 'text' || doc.original_file == null) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="doc-${doc.id}.txt"`
      );
      return res.send(doc.parsed_text || '');
    }

    const filename = sanitizeDownloadFilename(doc.filename, `document-${doc.id}`);
    res.setHeader('Content-Type', doc.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', attachmentDisposition(filename));
    return res.send(doc.original_file);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/documents/:id — document + chunks cascade
router.delete('/:id', async (req, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) return res.status(400).json({ error: 'Invalid document id' });

    const result = await db.query(
      `DELETE FROM legal_documents WHERE id = $1 AND user_id = $2 RETURNING id, filename`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await logAudit({
      userId: req.user.id,
      action: 'document.deleted',
      resourceType: 'document',
      resourceId: id,
      oldValue: { filename: result.rows[0].filename }
    });
    res.json({ ok: true, deletedId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/documents/search — vector similarity search across user's docs
router.post(
  '/search',
  limiters.documentSearch,
  validate([
    check('query').isString().trim().notEmpty().withMessage('query is required').isLength({ max: 5000 }),
    check('limit').optional().isInt({ min: 1, max: 50 })
  ]),
  async (req, res) => {
    try {
      const { query } = req.body;
      const limit = Math.min(Number.parseInt(req.body.limit, 10) || 5, 50);
      const results = await documentService.searchUserDocuments(query, req.user.id, limit);
      res.json({ results });
    } catch (error) {
      console.error('Document search error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
