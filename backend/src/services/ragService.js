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
  return documents.map(doc => 
    `Πηγή (Source): ${doc.source_type} - Άρθρο (Article): ${doc.article_number} - Τίτλος (Title): ${doc.title}\nΠεριεχόμενο (Content):\n${doc.content}\n---`
  ).join('\n');
}

module.exports = {
  retrieveContext,
  formatContextForGemma
};
