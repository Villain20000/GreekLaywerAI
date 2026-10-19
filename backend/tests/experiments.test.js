// AB_EXPERIMENTS parsing and the GET /api/config experiment contract.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const configRoutes = require('../src/routes/config');
const {
  parseExperiments,
  DEFAULT_EXPERIMENTS,
  DEFAULT_FEATURES
} = configRoutes;

const ORIGINAL_AB = process.env.AB_EXPERIMENTS;
const ORIGINAL_FLAGS = process.env.FEATURE_FLAGS;

function makeApp() {
  const app = express();
  app.use('/api/config', configRoutes);
  return app;
}

beforeEach(() => {
  delete process.env.AB_EXPERIMENTS;
  delete process.env.FEATURE_FLAGS;
});

afterAll(() => {
  if (ORIGINAL_AB === undefined) delete process.env.AB_EXPERIMENTS;
  else process.env.AB_EXPERIMENTS = ORIGINAL_AB;
  if (ORIGINAL_FLAGS === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = ORIGINAL_FLAGS;
});

const LANDING_DEFAULT = {
  'landing-hero': { variants: { control: 50, variant: 50 } }
};

describe('parseExperiments()', () => {
  it('parses and normalizes a valid experiment map', () => {
    const parsed = parseExperiments(
      JSON.stringify({
        'landing-hero': { variants: { control: 70, variant: 30 } },
        'pricing-cta': { variants: { control: 1, variant: 3 } }
      })
    );

    expect(parsed).toEqual({
      'landing-hero': { variants: { control: 70, variant: 30 } },
      'pricing-cta': { variants: { control: 1, variant: 3 } }
    });
  });

  it('falls back to the safe default for missing or blank config', () => {
    expect(parseExperiments(undefined)).toEqual(LANDING_DEFAULT);
    expect(parseExperiments(null)).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('')).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('   ')).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('{}')).toEqual(LANDING_DEFAULT);
  });

  it('falls back for invalid JSON and non-object roots', () => {
    expect(parseExperiments('{not json')).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('[]')).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('null')).toEqual(LANDING_DEFAULT);
    expect(parseExperiments('"landing-hero"')).toEqual(LANDING_DEFAULT);
  });

  it('falls back for malformed experiments or non-positive weights', () => {
    const invalid = [
      '{"landing-hero":null}',
      '{"landing-hero":[]}',
      '{"landing-hero":{"variants":null}}',
      '{"landing-hero":{"variants":[]}}',
      '{"landing-hero":{"variants":{}}}',
      '{"landing-hero":{"variants":{"control":0}}}',
      '{"landing-hero":{"variants":{"control":-10}}}',
      '{"landing-hero":{"variants":{"control":"50"}}}',
      '{"landing-hero":{"variants":{"control":null}}}',
      '{"landing-hero":{"variants":{"":{"control":1}}}}'
    ];

    for (const raw of invalid) {
      expect(parseExperiments(raw)).toEqual(LANDING_DEFAULT);
    }
  });

  it('rejects a partially valid map instead of leaking half a config', () => {
    const parsed = parseExperiments(
      JSON.stringify({
        'landing-hero': { variants: { control: 50, variant: 50 } },
        'pricing-cta': { variants: { control: 0, variant: 1 } }
      })
    );

    expect(parsed).toEqual(LANDING_DEFAULT);
  });

  it('copies only variants, so adjacent keys are never exposed', () => {
    const parsed = parseExperiments(
      JSON.stringify({
        'landing-hero': {
          variants: { control: 50, variant: 50 },
          secret: 'super-secret-value'
        }
      })
    );

    expect(parsed).toEqual(LANDING_DEFAULT);
    expect(parsed['landing-hero'].secret).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('super-secret-value');
  });
});

describe('GET /api/config experiments', () => {
  it('returns parsed experiments alongside the feature flags', async () => {
    process.env.AB_EXPERIMENTS = JSON.stringify({
      'landing-hero': { variants: { control: 60, variant: 40 } }
    });

    const res = await request(makeApp()).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.features).toEqual(DEFAULT_FEATURES);
    expect(res.body.experiments).toEqual({
      'landing-hero': { variants: { control: 60, variant: 40 } }
    });
  });

  it('returns the safe default for missing or invalid AB_EXPERIMENTS', async () => {
    const missing = await request(makeApp()).get('/api/config');
    expect(missing.body.experiments).toEqual(DEFAULT_EXPERIMENTS);

    process.env.AB_EXPERIMENTS = '{"landing-hero":{"variants":{"control":-1}}}';
    const invalid = await request(makeApp()).get('/api/config');
    expect(invalid.body.experiments).toEqual(DEFAULT_EXPERIMENTS);
  });

  it('is public and never echoes unrelated config values', async () => {
    process.env.AB_EXPERIMENTS = JSON.stringify({
      'landing-hero': {
        variants: { control: 50, variant: 50 },
        apiKey: 'should-not-leak'
      }
    });
    process.env.FEATURE_FLAGS = 'billing:false';

    const res = await request(makeApp()).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.features.billing).toBe(false);
    expect(res.text).not.toContain('should-not-leak');
  });
});
