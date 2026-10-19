// Offsite backup coverage for src/scripts/backupDb.js.
//
// The AWS SDK is mocked (no network) and upload streams are in-memory. The
// dump itself is a real temp file so "local dump survives a failed upload"
// and the local-only path are exercised for real.

const fs = require('fs');
const os = require('os');
const path = require('path');

let mockSdkLoadCount = 0;

// Streams are in-memory so a test that fails/aborts an upload can never leave
// an fs.ReadStream attempting to open a temp file after cleanup.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const { PassThrough } = jest.requireActual('stream');
  return {
    ...actual,
    createReadStream: jest.fn(() => new PassThrough())
  };
});

jest.mock('@aws-sdk/client-s3', () => {
  mockSdkLoadCount += 1;
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn().mockResolvedValue({})
    })),
    PutObjectCommand: jest.fn().mockImplementation((input) => ({ input }))
  };
});

const {
  buildS3Key,
  createS3Client,
  main,
  normalizeS3Prefix,
  runCli,
  uploadBackup
} = require('../src/scripts/backupDb');

// Deliberately required lazily inside tests: the first assertion below proves
// that requiring backupDb.js does not load the AWS SDK.
const sdkModule = () => require('@aws-sdk/client-s3');

let tmpDir;
let dumpPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomos-backup-s3-'));
  dumpPath = path.join(tmpDir, 'nomos_2026-10-19T02-00-00-000Z.dump');
  fs.writeFileSync(dumpPath, 'PGDMP fake archive');
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('S3 key building', () => {
  it('defaults to the nomosai/ prefix', () => {
    expect(buildS3Key(undefined, 'nomos_a.dump')).toBe('nomosai/nomos_a.dump');
    expect(buildS3Key('', 'nomos_a.dump')).toBe('nomosai/nomos_a.dump');
    expect(buildS3Key('   ', 'nomos_a.dump')).toBe('nomosai/nomos_a.dump');
  });

  it('normalizes slashes, whitespace and dot segments', () => {
    expect(normalizeS3Prefix('/backups/2026/')).toBe('backups/2026');
    expect(normalizeS3Prefix('team//db///')).toBe('team/db');
    expect(normalizeS3Prefix('team/../db')).toBe('team/db');
    expect(normalizeS3Prefix('..//..')).toBe('nomosai');
    expect(buildS3Key(' /backups/ ', 'nomos_a.dump')).toBe('backups/nomos_a.dump');
  });

  it('always uses the bare filename and rejects empty names', () => {
    expect(buildS3Key('prefix', 'nested/nomos_a.dump')).toBe('prefix/nomos_a.dump');
    expect(buildS3Key('prefix', '..\\nomos_a.dump')).toBe('prefix/nomos_a.dump');
    expect(() => buildS3Key('prefix', '')).toThrow(/filename/);
    expect(() => buildS3Key('prefix', '..')).toThrow(/filename/);
  });
});

describe('uploadBackup', () => {
  it('does not load or call the AWS SDK when no bucket is configured', async () => {
    expect(mockSdkLoadCount).toBe(0);

    await expect(uploadBackup({ filePath: dumpPath, env: {} })).resolves.toBeNull();
    await expect(uploadBackup({ filePath: dumpPath, env: { S3_REGION: 'eu-central-1' } }))
      .resolves.toBeNull();

    expect(mockSdkLoadCount).toBe(0);
  });

  it('sends PutObject with the expected bucket, key and SSE parameters', async () => {
    const sdk = sdkModule();
    const client = { send: jest.fn().mockResolvedValue({}) };
    const key = await uploadBackup({
      filePath: dumpPath,
      env: {
        BACKUP_S3_BUCKET: 'nomosai-backups',
        S3_PREFIX: '/db/nightly/',
        S3_SSE: 'AES256'
      },
      client
    });

    expect(key).toBe('db/nightly/nomos_2026-10-19T02-00-00-000Z.dump');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(sdk.PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({
      Bucket: 'nomosai-backups',
      Key: 'db/nightly/nomos_2026-10-19T02-00-00-000Z.dump',
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256'
    }));

    const params = sdk.PutObjectCommand.mock.calls[0][0];
    expect(fs.createReadStream).toHaveBeenCalledWith(dumpPath);
    expect(params.Body).toBe(fs.createReadStream.mock.results[0].value);
    params.Body.end('PGDMP fake archive');
  });

  it('builds the client from S3_* environment (endpoint, path style, static creds)', () => {
    const sdk = sdkModule();
    createS3Client({
      S3_REGION: 'eu-central-1',
      S3_ENDPOINT: 'https://minio.internal:9000',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'test-key',
      S3_SECRET_ACCESS_KEY: 'test-secret'
    });

    expect(sdk.S3Client).toHaveBeenCalledWith({
      region: 'eu-central-1',
      endpoint: 'https://minio.internal:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' }
    });
  });

  it('rejects when the SDK client rejects so the caller can fail the run', async () => {
    const client = { send: jest.fn().mockRejectedValue(new Error('AccessDenied')) };

    await expect(uploadBackup({
      filePath: dumpPath,
      env: { BACKUP_S3_BUCKET: 'nomosai-backups' },
      client
    })).rejects.toThrow('AccessDenied');
  });
});

describe('backup main/runCli', () => {
  function makeEnv(overrides = {}) {
    return { BACKUP_DIR: tmpDir, ...overrides };
  }

  function makeRunDump() {
    return jest.fn(async (destPath) => {
      fs.writeFileSync(destPath, 'PGDMP fake archive');
    });
  }

  it('keeps local-only behaviour when S3 is not configured', async () => {
    const runDump = makeRunDump();
    const upload = jest.fn();
    const prune = jest.fn();
    const writeMetric = jest.fn();

    const result = await main({
      env: makeEnv(),
      runDump,
      upload,
      prune,
      writeMetric
    });

    expect(result.uploadedKey).toBeNull();
    expect(fs.existsSync(result.destPath)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(prune).toHaveBeenCalledWith(14, tmpDir);
    expect(writeMetric).toHaveBeenCalledTimes(1);
  });

  it('uploads before pruning and publishing the success metric', async () => {
    const runDump = makeRunDump();
    const upload = jest.fn().mockResolvedValue('nomosai/nomos.dump');
    const prune = jest.fn();
    const writeMetric = jest.fn();

    const result = await main({
      env: makeEnv({ BACKUP_S3_BUCKET: 'nomosai-backups' }),
      runDump,
      upload,
      prune,
      writeMetric
    });

    expect(result.uploadedKey).toBe('nomosai/nomos.dump');
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      filePath: result.destPath
    }));
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(prune.mock.invocationCallOrder[0]);
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(writeMetric.mock.invocationCallOrder[0]);
    expect(prune).toHaveBeenCalledWith(14, tmpDir);
    expect(writeMetric).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero on upload failure and keeps the local dump for retry', async () => {
    const failDir = fs.mkdtempSync(path.join(tmpDir, 'failed-'));
    const runDump = makeRunDump();
    const upload = jest.fn().mockRejectedValue(new Error('S3 upload failed'));
    const prune = jest.fn();
    const writeMetric = jest.fn();

    const { exitCode, error } = await runCli({
      env: { BACKUP_DIR: failDir, BACKUP_S3_BUCKET: 'nomosai-backups' },
      runDump,
      upload,
      prune,
      writeMetric
    });

    expect(error.message).toBe('S3 upload failed');
    expect(exitCode).toBe(1);
    // A failed upload must not prune or advance the freshness metric.
    expect(prune).not.toHaveBeenCalled();
    expect(writeMetric).not.toHaveBeenCalled();

    const dumps = fs.readdirSync(failDir).filter((file) => file.endsWith('.dump'));
    expect(dumps).toHaveLength(1);
  });
});
