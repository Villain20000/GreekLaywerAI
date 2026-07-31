// Phase 29: Legal document processing pipeline.
//
// Flow: validate file → extract text (PDF/DOCX/TXT) → chunk text
// (~500 tokens, 50-token overlap) → embed each chunk (bge-m3, 1024-dim)
// → store document metadata + chunks + embeddings.

const db = require('../config/db');
const ollamaService = require('./ollamaService');
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
 * Extract raw text from a Buffer by detected content type.
 * PDF → pdf-parse, DOCX → mammoth, TXT → utf8 decode.
 */
async function extractText(buffer, contentType) {
  if (contentType === 'application/pdf') {
    const data = await getPdfParse()(buffer);
    return data.text || '';
  }
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await getMammoth().extractRawText({ buffer });
    return result.value || '';
  }
  // text/plain and anything else: decode as UTF-8
  return buffer.toString('utf8');
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
 * Full ingest pipeline: extract → chunk → embed → persist.
 * Returns the created document row (without the raw parsed_text for
 * the response envelope, which can be huge).
 */
async function processAndStoreDocument(userId, file, detectedType) {
  const { meta, text } = await extractMetadata(file.buffer, {
    contentType: detectedType,
    filename: file.originalname
  });

  const chunks = chunkText(text);

  const docResult = await db.query(
    `INSERT INTO legal_documents (user_id, filename, file_url, content_type, parsed_text, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, filename, content_type, metadata, created_at`,
    [userId, file.originalname, null, detectedType, text || null, JSON.stringify(meta)]
  );
  const document = docResult.rows[0];

  // Embed each chunk sequentially (local GPU: one embedding call at a time).
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await ollamaService.generateEmbedding(chunks[i]);
    const embeddingStr = `[${embedding.join(',')}]`;
    await db.query(
      `INSERT INTO legal_document_chunks (document_id, content, embedding, chunk_index)
       VALUES ($1, $2, $3::vector, $4)`,
      [document.id, chunks[i], embeddingStr, i]
    );
  }

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
async function searchUserDocuments(query, userId, limit = 5) {
  const queryEmbedding = await ollamaService.generateEmbedding(query);
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  const result = await db.query(
    `SELECT c.id AS chunk_id, c.content, c.chunk_index,
            1 - (c.embedding <=> $1::vector) AS similarity,
            d.id AS document_id, d.filename, d.title
     FROM legal_document_chunks c
     JOIN legal_documents d ON d.id = c.document_id
     WHERE d.user_id = $2
     ORDER BY c.embedding <=> $1::vector
     LIMIT $3`,
    [embeddingStr, userId, limit]
  );
  return result.rows;
}

module.exports = {
  chunkText,
  extractText,
  extractMetadata,
  processAndStoreDocument,
  searchUserDocuments,
  CHUNK_SIZE_TOKENS,
  CHUNK_OVERLAP_TOKENS
};
