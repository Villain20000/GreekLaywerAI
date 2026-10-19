/**
 * ingestLegislation.js
 *
 * Phase: 26 — Wires the Greek-law-scraping pipeline into the RAG layer.
 * Phase: 1-8 — `SCRAPED_LAWS_PATH` override + race-free `ON CONFLICT` dedupe.
 *
 * Before this change:
 *   - `generateEmbedding()` returned Math.random() vectors, so every
 *     pgvector query returned irrelevant hits. The LLM had no real
 *     legal context to draw on.
 *   - `scraped_laws.json` (output of `prototype_scraper.py`) was ignored.
 *   - `SCRAPED_LAWS_PATH` was documented but never read — an operator
 *     pointing the script at a mounted file silently got the mocks.
 *
 * After this change:
 *   - Embeddings come from a real Ollama embed model (e.g. `bge-m3`,
 *     1024-dim) and throw a descriptive error if the model isn't pulled.
 *   - This script reads `scraped_laws.json` from `SCRAPED_LAWS_PATH`
 *     when set, else `<repo-root>/scraped_laws.json` (the scraper's
 *     default output). In dev/test it merges the file with three small
 *     fallback mock articles so a brand-new env still has something to
 *     retrieve; in production the mock fallback is refused unless
 *     `ALLOW_MOCK_CORPUS=true`.
 *   - Re-runs are idempotent at the DB layer: a single race-free
 *     `INSERT ... ON CONFLICT (source_type, article_number) DO NOTHING`
 *     against the partial unique index created by
 *     `migrate-legislation-unique-index.js`. If a row already exists
 *     (same source_type + article_number) the fresh row is discarded by
 *     Postgres and reported as `skipped`; concurrent ingest runs can no
 *     longer insert duplicates.
 *     Choice of DO NOTHING over DO UPDATE: the documented contract is
 *     that re-runs of an unchanged corpus never rewrite (bump) existing
 *     embeddings — e.g. after an unrelated partial batch fails — and the
 *     vector rows stay stable for operators comparing similarity scores.
 *     Trade-off: the embed model is still called for every row (the DB
 *     resolves the race, so no pre-embed SELECT exists); re-scraping
 *     CHANGED text for an existing article therefore does not refresh it
 *     — delete that row (or TRUNCATE) and re-run to re-ingest it.
 *   - If `SCRAPED_LAWS_PATH` is set but points at a missing file, the
 *     script fails loudly instead of silently falling back to mocks
 *     (a broken mount should be visible in the operator's terminal).
 *
 * Requires `npm run migrate` (or the packaged container startup) to
 * have created the partial unique index before rows are upserted.
 *
 * Usage:
 *   docker exec -it greeklaywerai-backend-1 \
 *     node src/scripts/ingestLegislation.js
 *   # Point at a mounted file:
 *   docker exec -it -e SCRAPED_LAWS_PATH=/data/scraped_laws.json \
 *     greeklaywerai-backend-1 node src/scripts/ingestLegislation.js
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
// three directories up from this script. Override via SCRAPED_LAWS_PATH
// for a non-standard schema mount (e.g. a docker bind mount).
const DEFAULT_SCRAPED_LAWS_PATH = path.resolve(
  __dirname, '..', '..', '..', 'scraped_laws.json'
);

// Production must never silently index the toy corpus: an empty/missing
// scrape would otherwise look like a healthy RAG deployment. Operators can
// opt in explicitly for demos with ALLOW_MOCK_CORPUS=true.
function mockCorpusAllowed() {
  return process.env.NODE_ENV !== 'production' ||
    String(process.env.ALLOW_MOCK_CORPUS || '').toLowerCase() === 'true';
}

function productionCorpusError(reason) {
  const error = new Error(
    `[ingest] ${reason} NODE_ENV=production refuses to fall back to the embedded ` +
    '3-article mock corpus. Mount a real scraped_laws.json (SCRAPED_LAWS_PATH) ' +
    'or set ALLOW_MOCK_CORPUS=true only for an intentional demo environment.'
  );
  error.code = 'PRODUCTION_MOCK_CORPUS_FORBIDDEN';
  return error;
}

/**
 * Resolve which `scraped_laws.json` the ingest should read.
 *
 * Precedence (matches the README's "override via SCRAPED_LAWS_PATH"):
 *   1. `process.env.SCRAPED_LAWS_PATH` when set + non-blank (resolved to
 *      an absolute path so relative overrides behave predictably).
 *   2. `DEFAULT_SCRAPED_LAWS_PATH` (`<repo-root>/scraped_laws.json`).
 *
 * Read at CALL time (not module load) so a late `-e` / test env is honored.
 *
 * @returns {{ path: string, fromEnv: boolean }}
 */
function resolveScrapedLawsPath() {
  const override = (process.env.SCRAPED_LAWS_PATH || '').trim();
  if (override !== '') {
    return { path: path.resolve(override), fromEnv: true };
  }
  return { path: DEFAULT_SCRAPED_LAWS_PATH, fromEnv: false };
}

/**
 * Race-free idempotent upsert for one normalized row.
 *
 * The conflict target MUST repeat the partial index predicate
 * (`WHERE source_type IS NOT NULL AND article_number IS NOT NULL`),
 * otherwise Postgres cannot infer the partial unique index created by
 * `migrate-legislation-unique-index.js` and errors with
 * "no unique or exclusion constraint matching the ON CONFLICT
 * specification".
 *
 * DO NOTHING (see header): a re-run never duplicates or rewrites rows;
 * `rowCount === 0` is how the caller detects the skip.
 */
const INSERT_LEGISLATION_SQL = `
  INSERT INTO legislation_embeddings
      (source_type, article_number, title, content, embedding)
   VALUES ($1, $2, $3, $4, $5::vector)
   ON CONFLICT (source_type, article_number)
     WHERE source_type IS NOT NULL AND article_number IS NOT NULL
   DO NOTHING
`;

/**
 * Read `scraped_laws.json` from disk and normalize each entry into the
 * unified `{ source_type, article_number, title, content }` shape used by
 * `legislation_embeddings`.
 *
 * Failure semantics:
 *   - Explicit `scrapedPath` argument or an env-var override that points
 *     at a missing file → THROW with a clear message. The operator asked
 *     for a specific file; silently ingesting the mock corpus would hide
 *     a broken scrape/mount (Phase 1-8 bug).
 *   - Default path missing / unreadable / malformed → log and return []
 *     so the caller falls through to the mock articles instead of
 *     crashing a brand-new env.
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
function loadScrapedLaws(scrapedPath) {
  const resolved = scrapedPath
    ? { path: scrapedPath, fromEnv: false }
    : resolveScrapedLawsPath();
  const filePath = resolved.path;

  if (!fs.existsSync(filePath)) {
    if (resolved.fromEnv) {
      // Clear, actionable failure: the operator explicitly pointed at a
      // file (env var); falling back to mocks would mask the bad path.
      throw new Error(
        `[ingest] SCRAPED_LAWS_PATH points to ${filePath}, but no such file exists. ` +
        `Fix the path/mount, or unset SCRAPED_LAWS_PATH to use the default ` +
        `${DEFAULT_SCRAPED_LAWS_PATH} (or the 3 mock articles).`
      );
    }
    if (!mockCorpusAllowed()) {
      throw productionCorpusError(
        `No scraped_laws.json found at ${filePath}.`
      );
    }
    console.log(
      `[ingest] No scraped_laws.json found at ${filePath}. ` +
      `Falling back to the 3 mock articles (ALLOW_MOCK_CORPUS or non-production).`
    );
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      if (!mockCorpusAllowed()) {
        throw productionCorpusError(`${filePath} is not a JSON array.`);
      }
      console.warn(
        `[ingest] ${filePath} is not a JSON array — ignoring and using mocks.`
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
      `[ingest] Loaded ${normalized.length} scraped law(s) from ${filePath}.`
    );
    return normalized;
  } catch (err) {
    if (err && err.code === 'PRODUCTION_MOCK_CORPUS_FORBIDDEN') throw err;
    if (!mockCorpusAllowed()) {
      throw productionCorpusError(
        `Failed to read/parse ${filePath}: ${err.message}.`
      );
    }
    console.warn(
      `[ingest] Failed to read/parse ${filePath}: ${err.message}. ` +
      `Falling back to the 3 mock articles.`
    );
    return [];
  }
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

  // 1. Merge: scraped laws first (operator's preferred source), then the
  //    fallback mocks when allowed. Production (without ALLOW_MOCK_CORPUS)
  //    ingests the real corpus exclusively and fails if it is empty.
  const scraped = loadScrapedLaws();
  const allowMocks = mockCorpusAllowed();
  if (!allowMocks && scraped.length === 0) {
    throw productionCorpusError(
      'No usable legislation rows were loaded from the scraped corpus.'
    );
  }
  const corpus = allowMocks ? [...scraped, ...mockLegislation] : scraped;

  let inserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of corpus) {
    try {
      console.log(
        `[ingest] Vectorizing ${item.source_type} Άρθρο ${item.article_number}...`
      );
      const textToEmbed = buildEmbeddingText(item);
      // Will throw if Ollama is unreachable or the embed model isn't
      // pulled — surfaced to the operator rather than silently
      // placeholdered with Math.random() (the pre-fix bug class).
      const embedding = await generateEmbedding(textToEmbed);
      const embeddingStr = `[${embedding.join(',')}]`;

      const result = await db.query(INSERT_LEGISLATION_SQL, [
        item.source_type,
        item.article_number,
        item.title,
        item.content,
        embeddingStr
      ]);

      if (result.rowCount > 0) {
        console.log(
          `[ingest] Ingested ${item.source_type} Άρθρο ${item.article_number}.`
        );
        inserted++;
      } else {
        // ON CONFLICT DO NOTHING discarded the row: already present.
        console.log(
          `[ingest] Skip ${item.source_type} Άρθρο ${item.article_number} (already ingested).`
        );
        skipped++;
      }
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

  return { inserted, skipped, failed, total: corpus.length };
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

module.exports = {
  ingest,
  loadScrapedLaws,
  resolveScrapedLawsPath,
  mockCorpusAllowed,
  buildEmbeddingText,
  INSERT_LEGISLATION_SQL,
  DEFAULT_SCRAPED_LAWS_PATH
};
