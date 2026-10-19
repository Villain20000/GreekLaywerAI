#!/usr/bin/env node
// Replace the build-time placeholder origin (https://your-domain.gr) in the
// Angular build output. SITE_URL is a build arg, not a runtime variable, so
// the same image is not reusable across hostnames by design.
//
// Usage: SITE_URL=https://example.com npm run build

const fs = require('fs');
const path = require('path');

const PLACEHOLDER = 'https://your-domain.gr';
const DEFAULT_SITE_URL = PLACEHOLDER;
const BUILD_DIR = path.join(__dirname, '..', 'dist', 'nomos-ai-frontend', 'browser');
const TARGETS = ['index.html', 'sitemap.xml', 'robots.txt'];

function normalizeSiteUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error(`SITE_URL is empty; expected an absolute http(s) URL`);
  }

  let url;
  try {
    url = new URL(value);
  } catch (_err) {
    throw new Error(`SITE_URL is not a valid URL: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SITE_URL must use http or https: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`SITE_URL must be a bare origin (no credentials, query or hash): ${value}`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`SITE_URL must not include a path: ${value}`);
  }

  return url.origin;
}

function main() {
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL || DEFAULT_SITE_URL);

  if (!fs.existsSync(BUILD_DIR) || !fs.statSync(BUILD_DIR).isDirectory()) {
    throw new Error(
      `Angular build output not found at ${BUILD_DIR}. Run "ng build" before apply-site-url.js.`
    );
  }

  console.log(`[site-url] using ${siteUrl}`);

  for (const filename of TARGETS) {
    const filePath = path.join(BUILD_DIR, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Expected build output file is missing: ${filePath}`);
    }

    const before = fs.readFileSync(filePath, 'utf8');
    const replacements = before.split(PLACEHOLDER).length - 1;
    const after = before.split(PLACEHOLDER).join(siteUrl);

    if (after !== before) {
      fs.writeFileSync(filePath, after);
    }
    console.log(`[site-url] ${filename}: replaced ${replacements} occurrence(s)`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[site-url] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { main, normalizeSiteUrl, PLACEHOLDER, BUILD_DIR };
