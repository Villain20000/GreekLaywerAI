// GET /api/config feature-flag parsing and its public route contract.

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const configRoutes = require('../src/routes/config');
const {
  parseFeatureFlags,
  DEFAULT_FEATURES,
  DEFAULT_EXPERIMENTS
} = configRoutes;

const ORIGINAL_FLAGS = process.env.FEATURE_FLAGS;

function makeApp() {
  const app = express();
  app.use('/api/config', configRoutes);
  return app;
}

beforeEach(() => {
  delete process.env.FEATURE_FLAGS;
});

afterAll(() => {
  if (ORIGINAL_FLAGS === undefined) delete process.env.FEATURE_FLAGS;
  else process.env.FEATURE_FLAGS = ORIGINAL_FLAGS;
});

describe('parseFeatureFlags()', () => {
  it('enables every known feature by default', () => {
    const flags = parseFeatureFlags(undefined);

    expect(flags).toEqual({
      billing: true,
      documents: true,
      audio: true,
      adminDocuments: true
    });
    expect(flags).toEqual(DEFAULT_FEATURES);
  });

  it('accepts name:false style overrides while keeping other defaults', () => {
    const flags = parseFeatureFlags('documents:false,adminDocuments:false');

    expect(flags.billing).toBe(true);
    expect(flags.audio).toBe(true);
    expect(flags.documents).toBe(false);
    expect(flags.adminDocuments).toBe(false);
  });

  it('accepts 0/off/no as false and bare names as true', () => {
    const flags = parseFeatureFlags('billing:0, documents:off, audio:no, adminDocuments');

    expect(flags).toEqual({
      billing: false,
      documents: false,
      audio: false,
      adminDocuments: true
    });
  });

  it('ignores blank tokens and canonicalizes known flag casing', () => {
    const flags = parseFeatureFlags(' , admindocuments:false , ');

    expect(flags.adminDocuments).toBe(false);
    expect(flags.billing).toBe(true);
  });

  it('keeps unknown flags and defaults their explicit values', () => {
    const flags = parseFeatureFlags('betaSearch,experimental:false');

    expect(flags.betaSearch).toBe(true);
    expect(flags.experimental).toBe(false);
  });
});

describe('GET /api/config', () => {
  it('is public and returns the parsed feature map', async () => {
    process.env.FEATURE_FLAGS = 'documents:false,adminDocuments:false';

    const res = await request(makeApp()).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      features: {
        billing: true,
        documents: false,
        audio: true,
        adminDocuments: false
      },
      experiments: DEFAULT_EXPERIMENTS
    });
  });

  it('does not require an Authorization header', async () => {
    const res = await request(makeApp()).get('/api/config');

    expect(res.status).toBe(200);
    expect(res.body.features).toEqual(DEFAULT_FEATURES);
  });
});
