// Phase 1-6: real audio transcription (local whisper sidecar).
//
// Two layers:
//   1. transcriptionService unit tests — the REAL client. The happy path is
//      driven against a loopback HTTP server that asserts the multipart wire
//      contract; outage/empty/timeout paths use a mocked fetch plus a real
//      never-responding server (same pattern as tests/ollamaTimeout.test.js).
//   2. POST /api/ai/audio-query route tests — the shared tests/app.js mock
//      supplies the transcript / typed failures, proving the route enqueues
//      the REAL transcription and maps whisper outages onto 503/422.
// Nothing here touches the network beyond 127.0.0.1.
process.env.NODE_ENV = 'test';

const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('./app');
const db = require('../src/config/db');
const inferenceQueue = require('../src/services/inferenceQueue');
const ragService = require('../src/services/ragService');
const transcriptionService = require('../src/services/transcriptionService');

// The shared harness mocks the module for route tests; requireActual gives
// the unit tests the real client implementation.
const { TranscriptionError, ERROR_CODES } = transcriptionService;
const realTranscriptionService = jest.requireActual('../src/services/transcriptionService');

const JWT_SECRET = 'nomos-super-secret-key-development';
const WEBM_HEADER = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function userToken(overrides = {}) {
  return jwt.sign(
    {
      id: overrides.id ?? 2,
      email: overrides.email ?? 'user@nomos.ai',
      role: overrides.role ?? 'user',
      tv: 1
    },
    JWT_SECRET
  );
}

function queueAuth(overrides = {}) {
  db.query.mockResolvedValueOnce({
    rows: [{
      id: overrides.id ?? 2,
      email: 'user@nomos.ai',
      role: overrides.role ?? 'user',
      subscription_tier: overrides.subscription_tier ?? 'pro',
      created_at: new Date('2024-01-01T00:00:00Z'),
      token_version: 1
    }]
  });
  db.query.mockResolvedValue({ rows: [] });
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
}

/** Loopback stand-in for the speaches sidecar. Captures the raw request. */
function startRecordingServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        server.lastRequest = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        if (handler) return handler(req, res, server.lastRequest);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '  Τι προβλέπει ο ΚΠολΔ για την αναγκαστική εκτέλεση;  ' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('transcriptionService (real client)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.WHISPER_URL;
    delete process.env.WHISPER_MODEL;
    delete process.env.WHISPER_TIMEOUT_MS;
  });

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  it('POSTs multipart form-data to /v1/audio/transcriptions and returns the trimmed text', async () => {
    const server = await startRecordingServer();
    try {
      process.env.WHISPER_URL = `http://127.0.0.1:${server.address().port}/`; // trailing slash tolerated
      process.env.WHISPER_MODEL = 'Systran/faster-whisper-small';
      const audio = Buffer.from('omega raw audio bytes');

      const transcript = await realTranscriptionService.transcribe(audio, { mimeType: 'audio/webm' });

      expect(transcript).toBe('Τι προβλέπει ο ΚΠολΔ για την αναγκαστική εκτέλεση;');
      expect(server.lastRequest.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
      const body = server.lastRequest.body;
      expect(body).toContain('name="file"; filename="clip.webm"');
      expect(body).toContain('Content-Type: audio/webm');
      expect(body).toContain('name="model"');
      expect(body).toContain('Systran/faster-whisper-small');
      expect(body).toContain('name="response_format"');
      expect(body).toContain('json');
      expect(body).toContain('omega raw audio bytes');
    } finally {
      closeServer(server);
    }
  });

  it('defaults to the local sidecar URL and the base faster-whisper model', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ text: 'ok' }));
    global.fetch = fetchMock;

    await expect(realTranscriptionService.transcribe(Buffer.from('x'))).resolves.toBe('ok');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions');
    expect(options.method).toBe('POST');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get('model')).toBe('Systran/faster-whisper-base');
    expect(options.body.get('file').name).toBe('clip.bin'); // unknown mime fallback
  });

  it('classifies a connection failure as UNAVAILABLE / 503', async () => {
    process.env.WHISPER_URL = 'http://127.0.0.1:9';
    global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(realTranscriptionService.transcribe(Buffer.from('x'))).rejects.toMatchObject({
      name: 'TranscriptionError',
      code: ERROR_CODES.UNAVAILABLE,
      status: 503,
      publicMessage: 'Speech-to-text is temporarily unavailable'
    });
  });

  it('classifies an upstream HTTP error (unknown model, …) as UNAVAILABLE / 503', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('model not found', { status: 404 }));

    await expect(realTranscriptionService.transcribe(Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      status: 503
    });
  });

  it('classifies an empty transcript as EMPTY_TRANSCRIPT / 422', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ text: '   \n  ' }));

    await expect(realTranscriptionService.transcribe(Buffer.from('x'))).rejects.toMatchObject({
      name: 'TranscriptionError',
      code: ERROR_CODES.EMPTY_TRANSCRIPT,
      status: 422,
      publicMessage: 'Could not transcribe audio'
    });
  });

  it('treats an explicitly disabled WHISPER_URL as unavailable without calling fetch', async () => {
    process.env.WHISPER_URL = 'disabled';
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    await expect(realTranscriptionService.transcribe(Buffer.from('x'))).rejects.toMatchObject({
      code: ERROR_CODES.UNAVAILABLE,
      status: 503
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty audio buffer without calling fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    await expect(realTranscriptionService.transcribe(Buffer.alloc(0))).rejects.toMatchObject({
      code: ERROR_CODES.EMPTY_TRANSCRIPT,
      status: 422
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a hung sidecar after WHISPER_TIMEOUT_MS and reports it as unavailable', async () => {
    // Never responds: simulates a wedged/overloaded whisper container.
    const server = await startRecordingServer(() => {});
    try {
      process.env.WHISPER_URL = `http://127.0.0.1:${server.address().port}`;
      process.env.WHISPER_TIMEOUT_MS = '80';
      global.fetch = originalFetch; // exercise the real undici timeout path

      const startedAt = Date.now();
      await expect(realTranscriptionService.transcribe(Buffer.from('stuck-audio'))).rejects.toMatchObject({
        code: ERROR_CODES.UNAVAILABLE,
        status: 503
      });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      closeServer(server);
    }
  });

  it('exposes the typed error class the route switches on', () => {
    expect(new TranscriptionError('x', {})).toBeInstanceOf(Error);
    expect(TranscriptionError.name).toBe('TranscriptionError');
  });
});

describe('POST /api/ai/audio-query (real transcription wiring)', () => {
  afterEach(() => {
    db.query.mockReset();
    transcriptionService.transcribe.mockReset();
    transcriptionService.transcribe.mockResolvedValue('Μεταγραμμένο κείμενο δοκιμής');
    inferenceQueue.addInferenceJob.mockClear();
    ragService.retrieveContext.mockClear();
  });

  it('enqueues a job whose prompt is the transcript returned by whisper', async () => {
    queueAuth({ id: 2, subscription_tier: 'pro' });
    transcriptionService.transcribe.mockResolvedValueOnce(
      'Ποιο άρθρο ρυθμίζει την αναγκαστική εκτέλεση;'
    );

    const res = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('audio', Buffer.concat([WEBM_HEADER, Buffer.from('fake-audio')]), 'clip.webm');

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ jobId: 'mock-job-1' }); // {jobId} contract kept

    expect(transcriptionService.transcribe).toHaveBeenCalledWith(expect.any(Buffer), {
      mimeType: 'audio/webm'
    });
    expect(ragService.retrieveContext).toHaveBeenCalledWith(
      'Ποιο άρθρο ρυθμίζει την αναγκαστική εκτέλεση;'
    );
    expect(inferenceQueue.addInferenceJob).toHaveBeenCalledWith(
      'Ποιο άρθρο ρυθμίζει την αναγκαστική εκτέλεση;',
      'Formatted context',
      expect.objectContaining({
        userId: 2,
        prompt: 'Ποιο άρθρο ρυθμίζει την αναγκαστική εκτέλεση;'
      })
    );
  });

  it('returns 503 and enqueues nothing when whisper is unavailable', async () => {
    queueAuth({ id: 2, subscription_tier: 'pro' });
    transcriptionService.transcribe.mockRejectedValueOnce(
      new TranscriptionError('Could not reach whisper at http://whisper:8000', {
        code: ERROR_CODES.UNAVAILABLE,
        status: 503,
        publicMessage: 'Speech-to-text is temporarily unavailable'
      })
    );

    const res = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('audio', Buffer.concat([WEBM_HEADER, Buffer.from('fake-audio')]), 'clip.webm');

    expect(res.statusCode).toEqual(503);
    expect(res.body).toEqual({ error: 'Speech-to-text is temporarily unavailable' });
    expect(ragService.retrieveContext).not.toHaveBeenCalled();
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('returns 422 when whisper produces an empty transcript', async () => {
    queueAuth({ id: 2, subscription_tier: 'pro' });
    transcriptionService.transcribe.mockRejectedValueOnce(
      new TranscriptionError('Whisper returned an empty transcript', {
        code: ERROR_CODES.EMPTY_TRANSCRIPT,
        status: 422,
        publicMessage: 'Could not transcribe audio'
      })
    );

    const res = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('audio', Buffer.concat([WEBM_HEADER, Buffer.from('fake-audio')]), 'clip.webm');

    expect(res.statusCode).toEqual(422);
    expect(res.body).toEqual({ error: 'Could not transcribe audio' });
    expect(inferenceQueue.addInferenceJob).not.toHaveBeenCalled();
  });

  it('leaves untyped failures on the 500 path', async () => {
    queueAuth({ id: 2, subscription_tier: 'pro' });
    transcriptionService.transcribe.mockRejectedValueOnce(new Error('unexpected bug'));

    const res = await request(app)
      .post('/api/ai/audio-query')
      .set('Authorization', `Bearer ${userToken()}`)
      .attach('audio', Buffer.concat([WEBM_HEADER, Buffer.from('fake-audio')]), 'clip.webm');

    expect(res.statusCode).toEqual(500);
    expect(res.body.error).toBe('unexpected bug');
  });
});
