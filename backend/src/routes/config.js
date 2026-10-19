// Public runtime configuration consumed by the SPA.
//
// FEATURE_FLAGS is a comma-separated list. A bare name enables the flag;
// `name:false` (also 0/off/no) disables it. Unspecified known flags keep
// their default of `true`, so an empty value exposes every feature. Known
// names are matched case-insensitively and canonicalized to camelCase.

const express = require('express');
const router = express.Router();

const DEFAULT_FEATURES = Object.freeze({
  billing: true,
  documents: true,
  audio: true,
  adminDocuments: true
});

const KNOWN_FLAGS = new Map(
  Object.keys(DEFAULT_FEATURES).map((name) => [name.toLowerCase(), name])
);

const FALSE_VALUES = new Set(['false', '0', 'off', 'no']);

// A/B experiments are validated before they reach the SPA. The fallback is
// intentionally tiny and self-contained: malformed config must never disable
// the landing page or leak partially-parsed values.
const DEFAULT_EXPERIMENTS = Object.freeze({
  'landing-hero': Object.freeze({
    variants: Object.freeze({ control: 50, variant: 50 })
  })
});

function defaultExperiments() {
  return {
    'landing-hero': { variants: { control: 50, variant: 50 } }
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// JSON keys such as `__proto__` would mutate prototype slots on assignment.
const UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function parseExperiments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return defaultExperiments();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    return defaultExperiments();
  }

  if (!isPlainObject(parsed)) return defaultExperiments();

  const names = Object.keys(parsed);
  if (names.length === 0) return defaultExperiments();

  const experiments = {};
  for (const name of names) {
    if (!name.trim() || UNSAFE_NAMES.has(name)) return defaultExperiments();

    const definition = parsed[name];
    if (!isPlainObject(definition) || !isPlainObject(definition.variants)) {
      return defaultExperiments();
    }

    const entries = Object.entries(definition.variants);
    if (entries.length === 0) return defaultExperiments();

    const variants = {};
    for (const [variant, weight] of entries) {
      if (
        !variant.trim() ||
        UNSAFE_NAMES.has(variant) ||
        typeof weight !== 'number' ||
        !Number.isFinite(weight) ||
        weight <= 0
      ) {
        return defaultExperiments();
      }
      variants[variant] = weight;
    }

    // Only `variants` is copied, so unrelated keys (potential secrets)
    // configured alongside an experiment are never exposed.
    experiments[name] = { variants };
  }

  return experiments;
}

function parseFeatureFlags(raw) {
  const features = { ...DEFAULT_FEATURES };
  const tokens = String(raw || '').split(',');

  for (const token of tokens) {
    const entry = token.trim();
    if (!entry) continue;

    const separator = entry.indexOf(':');
    const rawName = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    if (!rawName) continue;

    const name = KNOWN_FLAGS.get(rawName.toLowerCase()) || rawName;
    if (separator === -1) {
      features[name] = true;
    } else {
      const rawValue = entry.slice(separator + 1).trim().toLowerCase();
      features[name] = !FALSE_VALUES.has(rawValue);
    }
  }

  return features;
}

router.get('/', (req, res) => {
  res.json({
    features: parseFeatureFlags(process.env.FEATURE_FLAGS),
    experiments: parseExperiments(process.env.AB_EXPERIMENTS)
  });
});

module.exports = router;
module.exports.parseFeatureFlags = parseFeatureFlags;
module.exports.DEFAULT_FEATURES = DEFAULT_FEATURES;
module.exports.parseExperiments = parseExperiments;
module.exports.DEFAULT_EXPERIMENTS = DEFAULT_EXPERIMENTS;
