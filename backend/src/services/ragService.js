const db = require('../config/db');
const ollamaService = require('./ollamaService');
const cacheService = require('./cacheService');
const ansvarMcpService = require('./ansvarMcpService');

const RAG_CACHE_TTL_SECONDS = positiveInt(process.env.RAG_CACHE_TTL_SECONDS, 300);

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Legislation retrieval is global (no user-scoped rows), so the cache key is
// a hash of the normalized query plus the top-K. Normalization collapses
// whitespace/case so equivalent prompts share an entry.
function ragCacheKey(query, limit) {
  const normalized = String(query || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `rag:context:${cacheService.hashKey(normalized)}:${limit}`;
}

function ansvarCacheKey(query, limit) {
  const normalized = String(query || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return `rag:context:ansvar:${cacheService.hashKey(normalized)}:${limit}`;
}

// Perform a similarity search in pgvector using the HNSW index
async function retrieveContext(query, limit = 5) {
  if (ansvarMcpService.isConfigured()) {
    const ansvarKey = ansvarCacheKey(query, limit);
    const cached = await cacheService.getJson(ansvarKey);
    if (Array.isArray(cached) && cached.length > 0) {
      return cached;
    }

    try {
      const ansvarDocuments = await ansvarMcpService.retrieveLegislation(query, limit);
      if (Array.isArray(ansvarDocuments) && ansvarDocuments.length > 0) {
        await cacheService.setJson(ansvarKey, ansvarDocuments, RAG_CACHE_TTL_SECONDS);
        return ansvarDocuments;
      }
    } catch (error) {
      console.warn(
        `[RAG] Ansvar MCP retrieval failed (${error.message}); falling back to the local pgvector corpus`
      );
    }
  }

  const cacheKey = ragCacheKey(query, limit);
  const cached = await cacheService.getJson(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

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
    if (Array.isArray(result.rows) && result.rows.length > 0) {
      await cacheService.setJson(cacheKey, result.rows, RAG_CACHE_TTL_SECONDS);
    }
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
