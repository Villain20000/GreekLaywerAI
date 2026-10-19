// P0-6: email transport selection + production fail-fast.
//
// These tests exercise the real emailService (not the giant test-double in
// tests/app.js), because the transport-selection logic IS the feature under
// test. emailService resolves its transport at module load, so each case
// loads a fresh registry with a controlled environment.
process.env.NODE_ENV = 'test';

const EMAIL_ENV_KEYS = [
  'EMAIL_TRANSPORT',
  'EMAIL_FROM',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'APP_BASE_URL'
];

function snapshotEnv() {
  const snap = { NODE_ENV: process.env.NODE_ENV };
  for (const k of EMAIL_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  process.env.NODE_ENV = snap.NODE_ENV;
  for (const k of EMAIL_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

/**
 * Load a fresh emailService with the given env, mocking nodemailer so no
 * real SMTP connection is attempted.
 * @returns {{ service: object, transport: { sendMail: jest.Mock } }}
 */
function loadFresh({ env = {}, sendMail } = {}) {
  jest.resetModules();
  for (const k of EMAIL_ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test';
  Object.assign(process.env, env);

  const transport = {
    sendMail: sendMail || jest.fn().mockResolvedValue({ messageId: 'msg-1' })
  };
  jest.doMock('nodemailer', () => ({
    createTransport: jest.fn(() => transport)
  }));

  const service = require('../src/services/emailService');
  return { service, transport };
}

describe('emailService transports (P0-6)', () => {
  let envSnap;
  beforeEach(() => {
    envSnap = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(envSnap);
    jest.resetModules();
  });

  it('refuses to load in production without SMTP configured', () => {
    jest.resetModules();
    for (const k of EMAIL_ENV_KEYS) delete process.env[k];
    process.env.NODE_ENV = 'production';

    expect(() => require('../src/services/emailService')).toThrow(
      /production email is not configured/i
    );
  });

  it('sends a verification email via SMTP in production', async () => {
    const { service, transport } = loadFresh({
      env: {
        NODE_ENV: 'production',
        EMAIL_TRANSPORT: 'smtp',
        EMAIL_FROM: 'NomosAI <no-reply@nomos.ai>',
        SMTP_HOST: 'smtp.example.gr',
        APP_BASE_URL: 'https://nomos.gr'
      }
    });

    await service.sendEmailVerification('user@example.gr', 'tok123');

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    const msg = transport.sendMail.mock.calls[0][0];
    expect(msg.to).toBe('user@example.gr');
    expect(msg.from).toBe('NomosAI <no-reply@nomos.ai>');
    expect(msg.text).toContain('https://nomos.gr/verify-email?token=tok123');
  });

  it('sends a password-reset email via SMTP with the reset URL', async () => {
    const { service, transport } = loadFresh({
      env: {
        EMAIL_TRANSPORT: 'smtp',
        EMAIL_FROM: 'NomosAI <no-reply@nomos.ai>',
        SMTP_HOST: 'smtp.example.gr',
        APP_BASE_URL: 'https://nomos.gr'
      }
    });

    await service.sendPasswordReset('user@example.gr', 'reset456');

    const msg = transport.sendMail.mock.calls[0][0];
    expect(msg.text).toContain('https://nomos.gr/reset-password?token=reset456');
  });

  it('retries transient SMTP failures with backoff', async () => {
    const sendMail = jest
      .fn()
      .mockRejectedValueOnce(new Error('greylisted'))
      .mockResolvedValue({ messageId: 'msg-2' });

    const { service, transport } = loadFresh({
      env: {
        EMAIL_TRANSPORT: 'smtp',
        EMAIL_FROM: 'NomosAI <no-reply@nomos.ai>',
        SMTP_HOST: 'smtp.example.gr'
      },
      sendMail
    });

    await service.sendEmailVerification('user@example.gr', 'tok');

    expect(transport.sendMail).toHaveBeenCalledTimes(2);
  });

  it('uses the console transport by default in dev (no SMTP needed)', async () => {
    const { service } = loadFresh();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await service.sendPasswordReset('dev@example.gr', 'tok456');
      // Assert before mockRestore() clears the recorded calls.
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('/reset-password?token=tok456')
      );
    } finally {
      log.mockRestore();
    }
  });
});
