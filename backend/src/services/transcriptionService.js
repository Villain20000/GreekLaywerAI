// Phase 1-6: local speech-to-text (STT) via an OpenAI-compatible whisper
// sidecar. Mirrors the ollamaService pattern — env-configured base URL,
// bounded outbound timeout (AbortSignal.timeout) and errors that are
// descriptive enough to debug but classified for the route to map onto
// stable HTTP statuses.
//
// The sidecar is the `whisper` service in docker-compose*.yml
// (ghcr.io/speaches-ai/speaches, faster-whisper). Nothing leaves the
// deployment: audio is POSTed to the local container only, which keeps the
// platform's privacy posture ("supabase"-free, local-model-first).
//
// Wire contract (OpenAI-compatible, so the image can be swapped):
//   POST ${WHISPER_URL}/v1/audio/transcriptions
//     multipart/form-data: file=<audio bytes>, model=<WHISPER_MODEL>
//   → 200 { "text": "…" }
//
// A container running slower than real time is expected on CPU (see the
// compose comments); the timeout is therefore generous and env-overridable.

const DEFAULT_WHISPER_URL = 'http://127.0.0.1:8000';
// Small multilingual faster-whisper checkpoint. Same model the compose
// sidecar pre-loads (PRELOAD_MODELS), so the request `model` field matches
// what is actually installed. Swap both to `-small`/`-large-v3` together.
const DEFAULT_WHISPER_MODEL = 'Systran/faster-whisper-base';
// 120 s covers a few minutes of audio on a CPU-only host; raise it for
// longer clips rather than removing the bound (a wedged sidecar must not
// pin the HTTP request forever).
const DEFAULT_WHISPER_TIMEOUT_MS = 120000;

// Error codes the route switches on. Kept as string constants (not just
// classes) so logs/ops dashboards can grep them.
const ERROR_CODES = {
  // Sidecar not configured / unreachable / returned a server error.
  UNAVAILABLE: 'TRANSCRIBE_UNAVAILABLE',
  // Request succeeded but produced no usable text.
  EMPTY_TRANSCRIPT: 'TRANSCRIBE_EMPTY'
};

/**
 * Typed failure raised by transcribe(). Carries:
 *  - code          → ERROR_CODES value (grep-able, stable)
 *  - status        → HTTP status the route must answer with
 *  - publicMessage → user-facing Greek-agnostic English copy (never leaks
 *                    internals such as the URL or the upstream body)
 */
class TranscriptionError extends Error {
  constructor(message, { code, status, publicMessage }) {
    super(message);
    this.name = 'TranscriptionError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function unavailability(message) {
  return new TranscriptionError(message, {
    code: ERROR_CODES.UNAVAILABLE,
    status: 503,
    publicMessage: 'Speech-to-text is temporarily unavailable'
  });
}

/**
 * Resolved sidecar base URL, or null when STT is deliberately disabled.
 * An explicit empty value / `off` / `disabled` / `none` (case-insensitive)
 * turns the feature off and produces the same 503 as an unreachable host.
 */
function getWhisperUrl() {
  const raw = process.env.WHISPER_URL;
  if (raw !== undefined) {
    const trimmed = raw.trim();
    if (trimmed === '' || /^(off|disabled|none)$/i.test(trimmed)) return null;
    return trimmed.replace(/\/+$/, '');
  }
  return DEFAULT_WHISPER_URL;
}

function getWhisperModel() {
  const raw = process.env.WHISPER_MODEL;
  return raw && raw.trim() ? raw.trim() : DEFAULT_WHISPER_MODEL;
}

function getWhisperTimeoutMs() {
  const parsed = Number(process.env.WHISPER_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WHISPER_TIMEOUT_MS;
}

// Browser-side blob types the API accepts (see middlewares/validation.js).
// The filename also becomes the multipart part's filename + Content-Type,
// which faster-whisper uses for format detection.
const AUDIO_FILENAMES = {
  'audio/webm': 'clip.webm',
  'audio/wav': 'clip.wav',
  'audio/mp4': 'clip.m4a'
};

/**
 * Transcribe an audio buffer through the local whisper sidecar.
 *
 * @param {Buffer} audioBuffer raw bytes of the recording
 * @param {{ mimeType?: string }} [options] sniffed content type (optional)
 * @returns {Promise<string>} the trimmed transcript (never empty)
 * @throws {TranscriptionError} UNAVAILABLE (503) or EMPTY_TRANSCRIPT (422)
 */
async function transcribe(audioBuffer, { mimeType } = {}) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new TranscriptionError('transcribe() requires a non-empty audio buffer', {
      code: ERROR_CODES.EMPTY_TRANSCRIPT,
      status: 422,
      publicMessage: 'Could not transcribe audio'
    });
  }

  const baseUrl = getWhisperUrl();
  if (!baseUrl) {
    throw unavailability('WHISPER_URL is not configured (speech-to-text disabled)');
  }

  const model = getWhisperModel();
  const form = new FormData();
  form.append(
    'file',
    new Blob([audioBuffer], { type: mimeType || 'application/octet-stream' }),
    AUDIO_FILENAMES[mimeType] || 'clip.bin'
  );
  form.append('model', model);
  form.append('response_format', 'json');

  let response;
  try {
    response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(getWhisperTimeoutMs())
    });
  } catch (error) {
    // Connection refused, DNS failure, timeout, TLS … — all "the sidecar is
    // not answering right now" from the caller's point of view.
    throw unavailability(
      `Could not reach whisper at ${baseUrl}/v1/audio/transcriptions: ${error && error.message}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = String(await response.text()).slice(0, 500);
    } catch (_) {
      // Body is best-effort debugging context only.
    }
    throw unavailability(
      `Whisper returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw unavailability(`Whisper returned a non-JSON body: ${error && error.message}`);
  }

  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    throw new TranscriptionError('Whisper returned an empty transcript', {
      code: ERROR_CODES.EMPTY_TRANSCRIPT,
      status: 422,
      publicMessage: 'Could not transcribe audio'
    });
  }

  return text;
}

module.exports = {
  transcribe,
  TranscriptionError,
  ERROR_CODES
};
