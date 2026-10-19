// Phase 29: Legal document processing pipeline.
//
// Flow: validate file → extract text (PDF/DOCX/TXT) → chunk text
// (~500 tokens, 50-token overlap) → embed each chunk (bge-m3, 1024-dim,
// bounded concurrency) → store document metadata + chunks + embeddings
// in one transaction (1-9).
//
// file_url is intentionally always NULL until object storage exists; the
// original upload bytes are persisted in `original_file` (BYTEA) together
// with `file_size` so the exact file can be downloaded (see schema.sql).

const db = require('../config/db');
const ollamaService = require('./ollamaService');
const ocrService = require('./ocrService');
const { logAudit } = require('./auditLog');

// Lazy requires so tests that never touch PDFs/DOCX don't pay the load cost.
let pdfParse = null;
let mammoth = null;
function getPdfParse() {
  if (!pdfParse) pdfParse = require('pdf-parse');
  return pdfParse;
}
function getMammoth() {
  if (!mammoth) mammoth = require('mammoth');
  return mammoth;
}

const CHUNK_SIZE_TOKENS = 500;
const CHUNK_OVERLAP_TOKENS = 50;

// 1-9: bound in-flight embedding calls so a large document does not
// saturate the local GPU — 3 concurrent requests is the sweet spot for
// Ollama on a single device.
const EMBEDDING_CONCURRENCY = 3;

/**
 * Rough token count (words + CJK-ish chars). Good enough for chunk sizing.
 */
function countTokens(text) {
  const words = (text.match(/\S+/g) || []).length;
  return words;
}

/**
 * Split text into ~CHUNK_SIZE_TOKENS chunks with CHUNK_OVERLAP_TOKENS
 * overlap. Splits on sentence boundaries when possible; hard-cuts when a
 * single sentence is longer than the chunk size.
 */
function chunkText(text, { chunkSize = CHUNK_SIZE_TOKENS, overlap = CHUNK_OVERLAP_TOKENS } = {}) {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  // Split into sentences on Greek/Latin sentence terminators.
  const sentences = normalized
    .split(/(?<=[.!?;…])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = [];
  let currentTokens = 0;

  const pushChunk = () => {
    if (current.length) {
      chunks.push(current.join(' '));
      current = [];
      currentTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);
    if (sentenceTokens > chunkSize) {
      // Oversized sentence: hard-cut by characters proportional to tokens.
      pushChunk();
      let rest = sentence;
      while (countTokens(rest) > chunkSize) {
        const ratio = rest.length / countTokens(rest); // chars per token
        const cutLen = Math.floor(chunkSize * ratio);
        let cut = rest.slice(0, cutLen);
        const spaceIdx = cut.lastIndexOf(' ');
        if (spaceIdx > cutLen * 0.6) cut = cut.slice(0, spaceIdx);
        chunks.push(cut.trim());
        rest = rest.slice(cut.length);
      }
      if (rest.trim()) current.push(rest.trim());
      currentTokens = countTokens(current.join(' '));
      continue;
    }

    if (currentTokens + sentenceTokens > chunkSize) {
      pushChunk();
      // Carry the tail of the previous chunk as overlap.
      if (overlap > 0 && chunks.length) {
        const prevWords = chunks[chunks.length - 1].split(/\s+/);
        const overlapWords = prevWords.slice(-Math.min(overlap, prevWords.length));
        if (overlapWords.length) {
          current.push(overlapWords.join(' '));
          currentTokens = overlapWords.length;
        }
      }
    }
    current.push(sentence);
    currentTokens += sentenceTokens;
  }
  pushChunk();

  return chunks.filter((c) => c && c.trim().length > 0);
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, preserving
 * result order. Stops pulling new items after the first failure, waits for
 * the in-flight calls to settle, then rejects with the first error.
 *
 * 1-9: used to overlap chunk embeddings (bounded pool) instead of awaiting
 * them strictly sequentially.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;

  const worker = async () => {
    while (firstError === null) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (firstError) throw firstError;
  return results;
}

/**
 * Extract metadata: byte size, word count, char count, page count (PDF),
 * creation/modified dates (PDF/DOCX) when available.
 */
async function extractMetadata(buffer, { contentType, filename, title }) {
  const meta = {
    size_bytes: buffer.length,
    filename: filename ? String(filename).replace(/[\\/]/g, '_') : null,
    contentType,
    title: title || null
  };

  let text = '';
  if (contentType === 'application/pdf') {
    try {
      const data = await getPdfParse()(buffer);
      text = data.text || '';
      if (typeof data.numpages === 'number') meta.page_count = data.numpages;
      if (data.info) {
        if (data.info.CreationDate) meta.created_date = String(data.info.CreationDate);
        if (data.info.ModDate) meta.modified_date = String(data.info.ModDate);
      }
    } catch (err) {
      // Metadata extraction never blocks the upload — fall through.
      console.warn('[DOC] PDF metadata extraction failed:', err.message);
    }
  } else if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await getMammoth().extractRawText({ buffer });
      text = result.value || '';
    } catch (err) {
      console.warn('[DOC] DOCX extraction failed:', err.message);
    }
  } else {
    text = buffer.toString('utf8');
  }

  meta.char_count = text.length;
  meta.word_count = (text.match(/\S+/g) || []).length;
  return { meta, text };
}

/**
 * Derive a page count from OCR page separators when pdf-parse could not
 * report `numpages` (e.g. the PDF metadata pass failed but mupdf rendered it).
 */
function countOcrPages(text) {
  const labels = [...String(text || '').matchAll(/--- Σελίδα (\d+) ---/g)]
    .map((match) => Number(match[1]));
  return labels.length > 0 ? Math.max(...labels) : 1;
}

/**
 * Full ingest pipeline: extract → chunk → embed → persist.
 * Returns the created document row (without the raw parsed_text for
 * the response envelope, which can be huge).
 *
 * Scanned PDFs (no text layer) are rasterized and OCRed before chunking.
 * OCR failures are non-fatal: the upload is stored without text.
 *
 * 1-9 atomicity + batching:
 *   - All embeddings are computed BEFORE any row is written, using a
 *     bounded pool (EMBEDDING_CONCURRENCY). A failed/partial embedding
 *     pass therefore cannot leave an orphaned document or partial chunks.
 *   - The document row and every chunk row are then written inside one
 *     BEGIN/COMMIT transaction on a single pooled connection, with
 *     ROLLBACK on any failure so the write side is all-or-nothing too.
 *   - Chunk rows are inserted in text order via their `chunk_index`.
 */
async function processAndStoreDocument(userId, file, detectedType, title) {
  const normalizedTitle = typeof title === 'string' && title.trim()
    ? title.trim().slice(0, 255)
    : null;
  const extraction = await extractMetadata(file.buffer, {
    contentType: detectedType,
    filename: file.originalname,
    title: normalizedTitle
  });
  const { meta } = extraction;
  let { text } = extraction;

  if (detectedType === 'application/pdf' && !text.trim()) {
    try {
      text = await ocrService.ocrPdf(file.buffer);
      meta.ocr_applied = true;
      if (!(Number.isFinite(meta.page_count) && meta.page_count > 0)) {
        meta.page_count = countOcrPages(text);
      }
      meta.char_count = text.length;
      meta.word_count = (text.match(/\S+/g) || []).length;
    } catch (error) {
      // Keep the upload successful; the file is stored without parsed text.
      text = '';
      meta.char_count = 0;
      meta.word_count = 0;
      console.warn(
        `[DOC] OCR failed for textless PDF (${error.code || 'OCR_ERROR'}): ${error.message}`
      );
    }
  }

  const chunks = chunkText(text);

  // Bounded-concurrency embedding pass (local GPU: max 3 in flight).
  const embeddings = await mapWithConcurrency(chunks, EMBEDDING_CONCURRENCY, (chunk) =>
    ollamaService.generateEmbedding(chunk)
  );

  // file_url stays NULL — the original bytes live in original_file.
  const client = await db.connect();
  let document;
  try {
    await client.query('BEGIN');

    const docResult = await client.query(
      `INSERT INTO legal_documents
         (user_id, filename, title, file_url, content_type, parsed_text, metadata, original_file, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, user_id, filename, title, content_type, metadata, file_size, created_at`,
      [
        userId,
        file.originalname,
        normalizedTitle,
        null,
        detectedType,
        text || null,
        JSON.stringify(meta),
        file.buffer,
        file.buffer.length
      ]
    );
    document = docResult.rows[0];

    for (let i = 0; i < chunks.length; i++) {
      const embeddingStr = `[${embeddings[i].join(',')}]`;
      await client.query(
        `INSERT INTO legal_document_chunks (document_id, content, embedding, chunk_index)
         VALUES ($1, $2, $3::vector, $4)`,
        [document.id, chunks[i], embeddingStr, i]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ROLLBACK is best-effort; the original error is what matters.
    }
    throw err;
  } finally {
    client.release();
  }

  // Audit after COMMIT (fail-open, so it never fails the upload) so the
  // transaction stays as short as possible.
  await logAudit({
    userId,
    action: 'document.uploaded',
    resourceType: 'document',
    resourceId: document.id,
    newValue: { filename: file.originalname, chunks: chunks.length, contentType: detectedType }
  });

  return { document, chunkCount: chunks.length };
}

/**
 * Vector similarity search across a user's document chunks.
 * Returns top-K chunks with document title/filename + similarity scores.
 */
async function searchUserDocuments(query, userId, limit = 5, documentIds = null) {
  const queryEmbedding = await ollamaService.generateEmbedding(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  const selectedIds = Array.isArray(documentIds)
    ? documentIds.filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const filter = selectedIds.length ? ' AND d.id = ANY($4::int[])' : '';
  const params = selectedIds.length
    ? [embeddingStr, userId, limit, selectedIds]
    : [embeddingStr, userId, limit];

  const result = await db.query(
    `SELECT c.id AS chunk_id, c.content, c.chunk_index,
            1 - (c.embedding <=> $1::vector) AS similarity,
            d.id AS document_id, d.filename, d.title
     FROM legal_document_chunks c
     JOIN legal_documents d ON d.id = c.document_id
     WHERE d.user_id = $2${filter}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    params
  );
  return result.rows;
}

module.exports = {
  chunkText,
  extractMetadata,
  processAndStoreDocument,
  searchUserDocuments
};
