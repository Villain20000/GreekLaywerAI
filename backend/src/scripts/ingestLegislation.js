/**
 * ingestLegislation.js
 *
 * Phase: 26 — Wires the Greek-law-scraping pipeline into the RAG layer.
 *
 * Before this change:
 *   - `generateEmbedding()` returned Math.random() vectors, so every
 *     pgvector query returned irrelevant hits. The LLM had no real
 *     legal context to draw on.
 *   - `scraped_laws.json` (output of `prototype_scraper.py`) was ignored.
 *
 * After this change:
 *   - Embeddings come from a real Ollama embed model (e.g. `nomic-embed-text`,
 *     768-dim) and throw a descriptive error if the model isn't pulled.
 *   - This script reads `<repo-root>/scraped_laws.json` (when present),
 *     normalizes each law into the `legislation_embeddings` schema, and
 *     merges with three small fallback mock articles so a brand-new env
 *     without scraped data still has something to retrieve.
 *   - Re-runs are idempotent at the row layer: a SELECT-then-INSERT
 *     pattern skips rows whose (source_type, article_number) match so
 *     re-running the script never duplicates or ever-bumps embeddings.
 *
 * Usage:
 *   docker exec -it greeklaywerai-backend-1 \
 *     node src/scripts/ingestLegislation.js
 *   # After running `prototype_scraper.py` to refresh scraped_laws.json at
 *   # the repo root, re-run this script to ingest the new laws.
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { generateEmbedding } = require('../services/ollamaService');

// Fallback mock corpus used when `scraped_laws.json` is absent (e.g.
// brand-new env before the Python scraper has been run). Three small
// articles are enough to demonstrate the RAG pipeline end-to-end.
const mockLegislation = [
  {
    source_type: 'Αστικός Κώδικας',
    article_number: '57',
    title: 'Δικαίωμα στην προσωπικότητα',
    content: 'Όποιος προσβάλλεται παράνομα στην προσωπικότητά του έχει δικαίωμα να απαιτήσει να αρθεί η προσβολή και να μην επαναληφθεί στο μέλλον.'
  },
  {
    source_type: 'Αστικός Κώδικας',
    article_number: '288',
    title: 'Εκπλήρωση ενοχής',
    content: 'Ο οφειλέτης έχει υποχρέωση να εκπληρώσει την παροχή όπως απαιτεί η καλή πίστη, αφού ληφθούν υπόψη και τα συναλλακτικά ήθη.'
  },
  {
    source_type: 'Ποινικός Κώδικας',
    article_number: '299',
    title: 'Ανθρωποκτονία με πρόθεση',
    content: 'Όποιος σκότωσε άλλον τιμωρείται με ισόβια κάθειρξη.'
  }
];

// Default scraper-output location is `<repo-root>/scraped_laws.json`,
// two directories up from this script. Override via SCRAPED_LAWS_PATH
// for a non-standard schema mount.
const DEFAULT_SCRAPED_LAWS_PATH = path.resolve(
  __dirname, '..', '..', '..', 'scraped_laws.json'
);

/**
 * Read `scraped_laws.json` from disk and normalize each entry into the
 * unified `{ source_type, article_number, title, content }` shape used by
 * `legislation_embeddings`. Returns an empty array on any failure so
 * the caller falls through to the mock articles instead of crashing.
 *
 * Schema mapping (scraper → DB row):
 *   source        → source_type   (e.g. 'ΦΕΚ' / 'Hellenic Parliament')
 *   law_number    → article_number (e.g. '4622/2019')
 *   law_title     → title
 *   full_text     → content
 *
 * Drops rows with missing critical fields rather than inserting NULL
 * titles that confuse the LLM.
 */
function loadScrapedLaws(scrapedPath = DEFAULT_SCRAPED_LAWS_PATH) {
  if (!fs.existsSync(scrapedPath)) {
    console.log(
      `[ingest] No scraped_laws.json found at ${scrapedPath}. ` +
      `Falling back to the 3 mock articles.`
    );
    return [];
  }
  try {
    const raw = fs.readFileSync(scrapedPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn(
        `[ingest] ${scrapedPath} is not a JSON array — ignoring and using mocks.`
      );
      return [];
    }
    const normalized = parsed
      .filter(law =>
        law && law.full_text && law.full_text.trim() !== '' &&
        law.law_number
      )
      .map(law => ({
        source_type: law.source || 'Unknown Source',
        article_number: String(law.law_number),
        title: law.law_title || `Law ${law.law_number}`,
        content: law.full_text
      }));
    console.log(
      `[ingest] Loaded ${normalized.length} scraped law(s) from ${scrapedPath}.`
    );
    return normalized;
  } catch (err) {
    console.warn(
      `[ingest] Failed to read/parse ${scrapedPath}: ${err.message}. ` +
      `Falling back to the 3 mock articles.`
    );
    return [];
  }
}

/**
 * SELECT-then-INSERT dedup check. Returns true iff a row with the same
 * (source_type, article_number) already exists; the caller skips the
 * INSERT to keep the run idempotent.
 *
 * App-level check rather than a DB unique constraint so this script
 * works on a freshly-initialised DB (no migration needed) and on an
 * existing DB (constraint not added). Trade-off: a race between two
 * concurrent ingest runs could insert a duplicate; in practice this
 * script is operator-console access, not production cron, and a
 * second pass would simply overwrite via the same hash anyway.
 */
async function alreadyExists(sourceType, articleNumber) {
  const result = await db.query(
    `SELECT 1 FROM legislation_embeddings
     WHERE source_type = $1 AND article_number = $2 LIMIT 1`,
    [sourceType, articleNumber]
  );
  return result.rowCount > 0;
}

/**
 * Build the text-to-embed for a single legislation row. Prefixing the
 * source + article + title gives the embedding model enough context to
 * cluster "Άρθρο 299" hits even when two scraped laws share words.
 */
function buildEmbeddingText(row) {
  return `${row.source_type} Άρθρο ${row.article_number}: ${row.title}. ${row.content}`.trim();
}

async function ingest() {
  console.log('Starting legislation ingestion...');

  // 1. Merge: scraped laws first (operator's preferred source), then
  //    fallback mocks. dedup at the per-row layer.
  const scraped = loadScrapedLaws();
  const corpus = [...scraped, ...mockLegislation];

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of corpus) {
    try {
      // Idempotency: skip rows whose (source + article) already exist.
      if (await alreadyExists(item.source_type, item.article_number)) {
        console.log(
          `[ingest] Skip ${item.source_type} Άρθρο ${item.article_number} (already ingested).`
        );
        skipped++;
        continue;
      }

      console.log(
        `[ingest] Vectorizing ${item.source_type} Άρθρο ${item.article_number}...`
      );
      const textToEmbed = buildEmbeddingText(item);
      // Will throw if Ollama is unreachable or the embed model isn't
      // pulled — surfaced to the operator rather than silently
      // placeholdered with Math.random() (the pre-fix bug class).
      const embedding = await generateEmbedding(textToEmbed);
      const embeddingStr = `[${embedding.join(',')}]`;

      await db.query(
        `INSERT INTO legislation_embeddings
            (source_type, article_number, title, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [
          item.source_type,
          item.article_number,
          item.title,
          item.content,
          embeddingStr
        ]
      );
      console.log(
        `[ingest] Ingested ${item.source_type} Άρθρο ${item.article_number}.`
      );
      inserted++;
    } catch (error) {
      failed++;
      console.error(
        `[ingest] Failed to ingest ${item.source_type} ` +
        `Άρθρο ${item.article_number}: ${error.message}`
      );
      // Keep going: one bad row should not abort the whole batch.
    }
  }

  console.log(
    `[ingest] Ingestion complete. ` +
    `inserted=${inserted} skipped=${skipped} failed=${failed} ` +
    `total=${corpus.length}.`
  );

  // Non-zero exit on ANY failure so CI/operator scripts notice partial
  // ingest loss (e.g. 1 of 100 rows succeeded because one Ollama embed
  // call timed out). Downstream tooling can inspect the per-row log to
  // distinguish "embed model not pulled" (every row failed) from
  // "transient flake" (one row failed).
  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  ingest().then(
    () => process.exit(process.exitCode || 0),
    err => {
      console.error('[ingest] Fatal error:', err);
      process.exit(1);
    }
  );
}

module.exports = { ingest, loadScrapedLaws, alreadyExists };
