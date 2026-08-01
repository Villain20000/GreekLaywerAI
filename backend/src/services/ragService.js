const db = require('../config/db');
const ollamaService = require('./ollamaService');

// Perform a similarity search in pgvector using the HNSW index
async function retrieveContext(query, limit = 5) {
  try {
    const queryEmbedding = await ollamaService.generateEmbedding(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    
    const sql = `
      SELECT id, source_type, article_number, title, content, 
             1 - (embedding <=> $1::vector) as similarity
      FROM legislation_embeddings
      ORDER BY embedding <=> $1::vector
      LIMIT $2;
    `;
    
    const result = await db.query(sql, [embeddingStr, limit]);
    return result.rows;
  } catch (error) {
    console.error('RAG Retrieval Error:', error);
    throw error;
  }
}

function formatContextForGemma(documents) {
  if (!documents || documents.length === 0) return '';
  return documents.map(doc => {
    if (doc.document_id !== undefined && doc.document_id !== null) {
      const title = doc.title || doc.filename || `Έγγραφο ${doc.document_id}`;
      const chunk = Number.isInteger(Number(doc.chunk_index)) ? ` - Τμήμα: ${doc.chunk_index}` : '';
      return `Πηγή (Uploaded document): ${title}${chunk}\nΠεριεχόμενο (Content):\n${doc.content}\n---`;
    }
    return `Πηγή (Source): ${doc.source_type || 'Νομοθεσία'} - Άρθρο (Article): ${doc.article_number || '—'} - Τίτλος (Title): ${doc.title || '—'}\nΠεριεχόμενο (Content):\n${doc.content}\n---`;
  }).join('\n');
}

function toSources(documents) {
  return (documents || []).map((doc) => {
    if (doc.document_id !== undefined && doc.document_id !== null) {
      return {
        type: 'document',
        id: Number(doc.document_id),
        title: doc.title || doc.filename || `Έγγραφο ${doc.document_id}`,
        filename: doc.filename || null,
        chunkIndex: Number.isInteger(Number(doc.chunk_index)) ? Number(doc.chunk_index) : null,
        similarity: Number.isFinite(Number(doc.similarity)) ? Number(doc.similarity) : null
      };
    }
    return {
      type: 'legislation',
      id: doc.id ?? null,
      title: doc.title || null,
      sourceType: doc.source_type || null,
      articleNumber: doc.article_number || null,
      similarity: Number.isFinite(Number(doc.similarity)) ? Number(doc.similarity) : null
    };
  });
}

function calculateConfidence(sources) {
  const scores = (sources || [])
    .map((source) => source && source.similarity)
    .filter((score) => score !== null && score !== undefined && score !== '')
    .map((score) => Number(score))
    .filter((score) => Number.isFinite(score));
  if (!scores.length) return 0;
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Number(Math.max(0, Math.min(1, average)).toFixed(2));
}

module.exports = {
  retrieveContext,
  formatContextForGemma,
  toSources,
  calculateConfidence
};
