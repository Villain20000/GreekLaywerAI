const { Ollama } = require('ollama');

const ollama = new Ollama({ host: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' });
const MODEL_NAME = 'gemma:2b'; // Placeholder for gemma:4b or gemma:12b
// Dedicated embedding model. Default to `bge-m3` because it emits
// 1024-dim vectors — matching the `legislation_embeddings.embedding
// vector(1024)` schema column (Phase 31). `bge-m3` is properly
// multilingual so Greek-language queries retrieve Greek-titled
// legislation correctly (nomic-embed-text was weak on cross-lingual
// bridging, ranked scraped Greek records below canonical-Greek mocks).
//
// NOTE: operators must `ollama pull bge-m3` once before the
// /api/ai/query route can return grounded LLM answers. We REFUSE to fall
// back to a noisy random vector (the pre-fix bug class) because random
// embeddings produced irrelevant pgvector hits and broke RAG silently.
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_DIM = (() => {
  const parsed = Number(process.env.OLLAMA_EMBED_DIM);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024;
})();

// Gemma 4 System Prompt for NomosAI
const SYSTEM_PROMPT = `
You are NomosAI, an elite Greek attorney expert in the Greek Legal System.
You provide precise, legally accurate answers based entirely on the provided legal context (laws, civil code, penal code, etc.).
Always respond in formal, professional Greek. If the provided context does not cover the question, state that you do not have enough information to form a legal opinion.
Never hallucinate laws or articles. Maintain strict compliance and clean formatting for Greek legal terms.
`;

async function generateResponse(prompt, context = '') {
  try {
    const fullPrompt = context ? `Σχετική νομοθεσία (Context):\n${context}\n\nΕρώτημα πελάτη (Question):\n${prompt}` : prompt;
    
    const response = await ollama.chat({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: fullPrompt }
      ],
      stream: false
    });
    
    return response.message.content;
  } catch (error) {
    console.error('Ollama generation error:', error);
    throw error;
  }
}

async function streamResponse(prompt, context = '', res) {
  try {
    const fullPrompt = context ? `Σχετική νομοθεσία (Context):\n${context}\n\nΕρώτημα πελάτη (Question):\n${prompt}` : prompt;
    
    const responseStream = await ollama.chat({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: fullPrompt }
      ],
      stream: true
    });
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    for await (const chunk of responseStream) {
      if (chunk.message && chunk.message.content) {
        res.write(`data: ${JSON.stringify({ content: chunk.message.content })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('Ollama streaming error:', error);
    res.write(`data: ${JSON.stringify({ error: 'Inference failed' })}\n\n`);
    res.end();
  }
}

// Generate embeddings via the local Ollama embedding model. This is the
// real vectorizer for the RAG pipeline — it replaced a Math.random()-based
// 768-dim placeholder because random vectors produced irrelevant
// pgvector hits and the LLM had no usable legal context.
//
// On failure (Ollama down / model not pulled / network) we THROW a
// descriptive error rather than silently degrading to noise. The callers
// (`ragService.retrieveContext`, `ingestLegislation.js`) propagate the
// error into a 500 so the operator notices and pulls the embed model.
//
// Operators can recover by running:
//   docker exec greeklaywerai-ollama-1 ollama pull bge-m3
// Phase 28 (pre-warm): state + idempotent warmup that pays the cold-load
// penalty ONCE at container startup so the first /api/ai/query doesn't
// hang for ~180 s while gemma:2b loads from disk into Ollama memory. The
// first /api/ai/query/stream hit previously clocked 7.9 s after warmup,
// but the pre-warm call itself IS the first hit, so it absorbs the
// initial ~30–120 s load while the server is still booting.
const warmupState = {
  embedWarmed: false,
  embedWarmedAt: null,
  chatWarmed: false,
  chatWarmedAt: null
};

let warmupPromise = null;

/**
 * Operator-driven recovery from a partial warmup failure (e.g. Ollama
 * reachable mid-leg but the chat model wasn't pulled yet, or a transient
 * disk error on the first attempt). Clears the singleton promise so the
 * next warmup() call actually runs a fresh attempt; both flags reset to
 * false so getWarmupStatus() reports `warming` again.
 *
 * Idempotent: calling reset when no warmup is in progress is a no-op.
 * Exported (not just internal) so an admin CLI / future operator tooling
 * can recover without container restart.
 */
function warmupReset() {
  warmupPromise = null;
  warmupState.embedWarmed = false;
  warmupState.embedWarmedAt = null;
  warmupState.chatWarmed = false;
  warmupState.chatWarmedAt = null;
}

/**
 * Pre-warm both Ollama models in a fire-and-forget manner.
 *
 * - Idempotent: calling warmup() repeatedly returns the same Promise
 *   (BOTH references equal — the singleton promise is returned BY
 *   REFERENCE, not wrapped in a fresh outer Promise, so concurrent
 *   callers observe the very same warmup status via `Object.is`).
 * - Never throws: each leg's failure is logged at WARN level and the
 *   `embedWarmed`/`chatWarmed` flag stays false. Callers can introspect
 *   via getWarmupStatus() to know whether the model is ready yet.
 * - Safe to call concurrently: the singleton promise coalesces races.
 *
 * Note: this function is intentionally NOT declared `async` so it
 * returns the inner Promise BY REFERENCE instead of wrapping it in a
 * new Promise. Wrapping would break callers that compare promise
 * identities for idempotency (e.g. jest.toBe). Callers should still
 * `await` it as usual — awaiting a non-async function returning a
 * Promise is the same as awaiting the Promise directly.
 */
function warmup() {
  if (warmupPromise) return warmupPromise;

  warmupPromise = (async () => {
    // Embed leg — minimal cost (bge-m3 is small). Confirms the
    // model is loaded AND that it returns a dimensionally-correct vector.
    try {
      const resp = await ollama.embeddings({ model: EMBED_MODEL, prompt: 'warmup' });
      const vec = resp && resp.embedding;
      if (Array.isArray(vec) && vec.length === EMBED_DIM) {
        warmupState.embedWarmed = true;
        warmupState.embedWarmedAt = new Date().toISOString();
      } else {
        console.warn(
          `[warmup] ${EMBED_MODEL} returned no/short embedding (length=${vec && vec.length}, expected=${EMBED_DIM})`
        );
      }
    } catch (err) {
      console.warn(
        `[warmup] embed warmup failed (model=${EMBED_MODEL}): ${err && err.message}`
      );
    }

    // Chat leg — heaviest. Loads gemma:2b weights into memory. The first
    // /generate call after this returns in single-digit seconds instead of
    // 180+ s. We swallow any error so a partial warmup (embed ok, chat
    // failing) doesn't crash the boot path.
    try {
      const resp = await ollama.chat({
        model: MODEL_NAME,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false
      });
      if (resp && resp.message && typeof resp.message.content === 'string') {
        warmupState.chatWarmed = true;
        warmupState.chatWarmedAt = new Date().toISOString();
      } else {
        console.warn(`[warmup] ${MODEL_NAME} returned no message.content`);
      }
    } catch (err) {
      console.warn(
        `[warmup] chat warmup failed (model=${MODEL_NAME}): ${err && err.message}`
      );
    }
  })();

  return warmupPromise;
}

/**
 * Snapshot of the current warmup state for /api/ai/health and /health.
 * Format:
 *  - status: 'ready' only if BOTH models warmed; 'warming' if either
 *    leg is still pending or failed
 *  - embedModel / chatModel / embedDim: the resolved names + dim so an
 *    operator can grep /api/ai/health and immediately see what the
 *    backend CLAIMS to use (often useful when env-vars drift)
 *  - *Warmed: boolean per leg
 *  - *WarmedAt: ISO timestamp (or null if the leg hasn't completed)
 */
function getWarmupStatus() {
  const ready = warmupState.embedWarmed && warmupState.chatWarmed;
  return {
    status: ready ? 'ready' : 'warming',
    embedModel: EMBED_MODEL,
    embedDim: EMBED_DIM,
    embedWarmed: warmupState.embedWarmed,
    embedWarmedAt: warmupState.embedWarmedAt,
    chatModel: MODEL_NAME,
    chatWarmed: warmupState.chatWarmed,
    chatWarmedAt: warmupState.chatWarmedAt
  };
}

async function generateEmbedding(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('generateEmbedding requires a non-empty string input');
  }
  try {
    const response = await ollama.embeddings({
      model: EMBED_MODEL,
      prompt: text
    });
    const vector = response && response.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(
        `Ollama embed model '${EMBED_MODEL}' returned an empty embedding. ` +
        `Did you 'docker exec greeklaywerai-ollama-1 ollama pull ${EMBED_MODEL}'?`
      );
    }
    // Sanity-check dimension matches what the schema expects. A mismatch
    // would crash every pgvector query with a `vector dimension mismatch`
    // error, so fail loudly here with an actionable hint instead.
    if (vector.length !== EMBED_DIM) {
      throw new Error(
        `Embedding dimension mismatch: schema expects vector(${EMBED_DIM}) ` +
        `but model '${EMBED_MODEL}' returned ${vector.length} dims. ` +
        `Verify OLLAMA_EMBED_MODEL + OLLAMA_EMBED_DIM align with the column ` +
        `width of legislation_embeddings.embedding (current schema column = ` +
        `vector(${EMBED_DIM})). If they don't match, either pick a model ` +
        `whose output dim equals EMBED_DIM, or run a one-shot pgvector ` +
        `ALTER + TRUNCATE + re-ingest to resize the column.`
      );
    }
    return vector;
  } catch (error) {
    // Surface a uniform, actionable wrapper so callers and logs make it
    // obvious that the operator action is `ollama pull`.
    if (error && error.message && /ENOTFOUND|ECONNREFUSED|fetch failed/i.test(error.message)) {
      throw new Error(
        `Could not reach Ollama at ${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'} ` +
        `for embeddings: ${error.message}. Is the 'ollama' container up?`
      );
    }
    throw error;
  }
}

module.exports = {
  generateResponse,
  streamResponse,
  generateEmbedding,
  warmup,
  warmupReset,
  getWarmupStatus
};
