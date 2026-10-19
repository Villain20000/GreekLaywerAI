// Optional Sentry wiring: no-op without a DSN, mocked SDK when configured.

process.env.NODE_ENV = 'test';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  captureException: jest.fn()
}));

const ORIGINAL_ENV = {
  SENTRY_DSN: process.env.SENTRY_DSN,
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE
};

function loadSentry() {
  // Fresh module state per test so the double-init guard is isolated.
  jest.resetModules();
  const sdk = require('@sentry/node');
  const sentry = require('../src/config/sentry');
  return { sdk, sentry };
}

beforeEach(() => {
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_ENVIRONMENT;
  delete process.env.SENTRY_TRACES_SAMPLE_RATE;
});

afterAll(() => {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('initSentry()', () => {
  it('does not initialize or capture anything without SENTRY_DSN', () => {
    const { sdk, sentry } = loadSentry();

    expect(sentry.initSentry()).toBe(false);
    expect(sdk.init).not.toHaveBeenCalled();

    expect(() => sentry.captureException(new Error('offline'))).not.toThrow();
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('initializes the SDK with privacy-safe defaults when a DSN is set', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { sdk, sentry } = loadSentry();

    expect(sentry.initSentry()).toBe(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith({
      dsn: 'https://public@example.com/1',
      environment: 'test',
      tracesSampleRate: 0,
      sendDefaultPii: false
    });
  });

  it('honors SENTRY_ENVIRONMENT and SENTRY_TRACES_SAMPLE_RATE', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.25';
    const { sdk, sentry } = loadSentry();

    sentry.initSentry();

    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'staging',
        tracesSampleRate: 0.25
      })
    );
  });

  it('falls back to 0 for invalid sample rates and clamps out-of-range values', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    process.env.SENTRY_TRACES_SAMPLE_RATE = 'not-a-number';
    let loaded = loadSentry();
    loaded.sentry.initSentry();
    expect(loaded.sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({ tracesSampleRate: 0 })
    );

    process.env.SENTRY_TRACES_SAMPLE_RATE = '7';
    loaded = loadSentry();
    loaded.sentry.initSentry();
    expect(loaded.sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({ tracesSampleRate: 1 })
    );
  });

  it('guards against double initialization', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { sdk, sentry } = loadSentry();

    expect(sentry.initSentry()).toBe(true);
    expect(sentry.initSentry()).toBe(true);

    expect(sdk.init).toHaveBeenCalledTimes(1);
  });

  it('never throws when SDK initialization fails', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { sdk, sentry } = loadSentry();
    sdk.init.mockImplementation(() => {
      throw new Error('bad dsn');
    });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(sentry.initSentry()).toBe(false);
    expect(sentry.captureException(new Error('x'))).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('captureException()', () => {
  it('is a no-op before initialization even when a DSN is configured', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { sdk, sentry } = loadSentry();

    expect(sentry.captureException(new Error('early'))).toBe(false);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });

  it('forwards to the SDK once initialized and never throws on SDK failure', () => {
    process.env.SENTRY_DSN = 'https://public@example.com/1';
    const { sdk, sentry } = loadSentry();
    sentry.initSentry();
    const error = new Error('boom');

    expect(sentry.captureException(error)).toBe(true);
    expect(sdk.captureException).toHaveBeenCalledWith(error);

    sdk.captureException.mockImplementation(() => {
      throw new Error('transport down');
    });
    expect(() => sentry.captureException(error)).not.toThrow();
  });
});

describe('global error handler with Sentry disabled', () => {
  let handler;
  let sdk;

  beforeAll(() => {
    // beforeAll runs before the top-level beforeEach, so clear any DSN left
    // behind by the preceding describe block.
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_ENVIRONMENT;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    handler = require('../src/index').globalErrorHandler;
    warnSpy.mockRestore();
    sdk = require('@sentry/node');
  });

  function invoke(error) {
    const res = {
      headersSent: false,
      statusCode: 200,
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };
    const next = jest.fn();
    handler(error, { method: 'GET', originalUrl: '/__test__/boom' }, res, next);
    return { res, next };
  }

  it('keeps the generic 500 JSON envelope', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { res, next } = invoke(new Error('secret internal details'));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();
    expect(sdk.captureException).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('keeps the 400 JSON mapping for malformed request bodies', () => {
    const error = new SyntaxError('Unexpected token');
    error.status = 400;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { res } = invoke(error);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON payload' });
    expect(sdk.captureException).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
