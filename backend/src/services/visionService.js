// Optional image understanding through a local Ollama vision model
// (OLLAMA_VISION_MODEL, e.g. `llava`). Nothing is pulled automatically: when
// the variable is unset/disabled the route skips this service and uses OCR.
// Failures are typed so the route can fall back to OCR instead of failing the
// upload.

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 120000;

const ERROR_CODES = {
  NOT_CONFIGURED: 'VISION_NOT_CONFIGURED',
  UNAVAILABLE: 'VISION_UNAVAILABLE',
  EMPTY_RESPONSE: 'VISION_EMPTY'
};

// Same role as ollamaService's system prompt: grounded Greek legal analysis.
const SYSTEM_PROMPT = `
You are NomosAI, an elite Greek attorney expert in the Greek Legal System.
Analyze the attached image and answer in formal, professional Greek based only
on its visible content and the provided legal context. If the image is not a
legal document or the content is illegible, say so instead of inventing facts.
Never hallucinate laws or articles.
`;

class VisionError extends Error {
  constructor(message, { code, status, publicMessage }) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

function getVisionModel() {
  const raw = process.env.OLLAMA_VISION_MODEL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /^(off|disabled|none)$/i.test(trimmed)) return null;
  return trimmed;
}

function isConfigured() {
  return Boolean(getVisionModel());
}

function getTimeoutMs() {
  const parsed = Number(process.env.OLLAMA_VISION_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function getOllamaHost() {
  const raw = process.env.OLLAMA_URL;
  return raw && raw.trim() ? raw.trim().replace(/\/+$/, '') : DEFAULT_OLLAMA_URL;
}

// The ollama client accepts a custom fetch; injecting AbortSignal.timeout here
// bounds every outbound request without relying on the client's own defaults.
function visionFetch(url, options = {}) {
  const timeoutSignal = AbortSignal.timeout(getTimeoutMs());
  const signal = options.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([options.signal, timeoutSignal])
    : (options.signal || timeoutSignal);
  return fetch(url, { ...options, signal });
}

/**
 * Ask the configured Ollama vision model to analyze an image.
 *
 * @param {Buffer} imageBuffer image bytes (never logged/echoed)
 * @param {{ mimeType?: string, prompt?: string, context?: string }} [options]
 *   `prompt` is the Greek legal-analysis instruction (built by the route);
 *   `context` is formatted RAG grounding.
 * @returns {Promise<string>} trimmed model answer
 * @throws {VisionError} NOT_CONFIGURED (503), UNAVAILABLE (502), EMPTY (502)
 */
async function analyzeImage(imageBuffer, { prompt, context } = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new VisionError('analyzeImage() requires a non-empty image buffer', {
      code: ERROR_CODES.UNAVAILABLE,
      status: 400,
      publicMessage: 'Invalid image upload'
    });
  }

  const model = getVisionModel();
  if (!model) {
    throw new VisionError('OLLAMA_VISION_MODEL is not configured', {
      code: ERROR_CODES.NOT_CONFIGURED,
      status: 503,
      publicMessage: 'Image analysis is not configured'
    });
  }

  const instruction = typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : 'Ανέλυσε την εικόνα νομικού εγγράφου και σχολίασε τα βασικά νομικά σημεία.';
  const fullPrompt = context
    ? `Σχετική νομοθεσία (Context):\n${context}\n\n${instruction}`
    : instruction;

  let response;
  try {
    // Lazy require keeps `ollama` out of the module graph unless vision is used.
    const { Ollama } = require('ollama');
    const client = new Ollama({ host: getOllamaHost(), fetch: visionFetch });
    response = await client.chat({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: fullPrompt, images: [imageBuffer.toString('base64')] }
      ],
      stream: false
    });
  } catch (error) {
    throw new VisionError(
      `Vision model '${model}' request failed: ${error && error.message ? error.message : 'unknown error'}`,
      {
        code: ERROR_CODES.UNAVAILABLE,
        status: 502,
        publicMessage: 'Image analysis is temporarily unavailable'
      }
    );
  }

  const text = response && response.message && typeof response.message.content === 'string'
    ? response.message.content.trim()
    : '';
  if (!text) {
    throw new VisionError(`Vision model '${model}' returned no text`, {
      code: ERROR_CODES.EMPTY_RESPONSE,
      status: 502,
      publicMessage: 'Image analysis returned no text'
    });
  }

  return text;
}

module.exports = {
  analyzeImage,
  isConfigured,
  getVisionModel,
  VisionError,
  ERROR_CODES
};
