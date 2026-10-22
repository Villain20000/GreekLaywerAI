// Greek-law retrieval through the Ansvar MCP gateway.
//
// The gateway speaks MCP Streamable HTTP and is protected by Keycloak. The
// service authenticates with a pre-issued bearer token or the OAuth 2.0
// client-credentials grant, discovers the search tool, and normalizes the
// tool result into the same row shape ragService already uses for pgvector.
// Any failure is the caller's cue to fall back to the local corpus; this
// module never throws into a chat request by itself.

const crypto = require('crypto');
const { getSecret } = require('../config/secrets');

const DEFAULT_MCP_URL = 'https://gateway.ansvar.eu/mcp';
const DEFAULT_TOKEN_URL =
  'https://auth.ansvar.eu/realms/ansvar/protocol/openid-connect/token';
const DEFAULT_SCOPE = 'mcp:tools';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SESSION_TTL_MS = 300000;
const PROTOCOL_VERSION = '2025-03-26';
const CLIENT_INFO = { name: 'nomosai-backend', version: '1.0.0' };
const MAX_CONTENT_CHARS = 12000;

let nextRpcId = 1;
let tokenCache = { key: null, token: null, expiresAt: 0 };
let sessionCache = null;
let warnedSecretFailure = false;

function env(name) {  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInt(value, fallback, max = 120000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function getConfig() {
  let clientSecret = '';
  let token = '';
  try {
    clientSecret = (getSecret('ANSVAR_CLIENT_SECRET', '') || '').trim();
    token = (getSecret('ANSVAR_MCP_TOKEN', '') || '').trim().replace(/^Bearer\s+/i, '');
  } catch (err) {
    // A broken secret file must surface in logs, but retrieval stays optional:
    // the local corpus still answers the user.
    if (!warnedSecretFailure) {
      warnedSecretFailure = true;
      console.error(`[ANSVAR] secret resolution failed: ${err.message}`);
    }
  }

  const clientId = env('ANSVAR_CLIENT_ID');
  const configured = Boolean(token || (clientId && clientSecret));
  const enabled = configured && env('ANSVAR_MCP_ENABLED').toLowerCase() !== 'false';

  return {
    url: env('ANSVAR_MCP_URL') || DEFAULT_MCP_URL,
    tokenUrl: env('ANSVAR_TOKEN_URL') || DEFAULT_TOKEN_URL,
    token,
    clientId,
    clientSecret,
    scope: env('ANSVAR_SCOPE') || DEFAULT_SCOPE,
    toolName: env('ANSVAR_TOOL_NAME'),
    argsTemplate: env('ANSVAR_TOOL_ARGS'),
    timeoutMs: positiveInt(env('ANSVAR_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS),
    sessionTtlMs: positiveInt(env('ANSVAR_SESSION_TTL_MS'), DEFAULT_SESSION_TTL_MS, 3600000),
    enabled,
    configured
  };
}

function isConfigured() {
  return getConfig().enabled;
}

function getStatus() {
  const cfg = getConfig();
  return {
    status: cfg.enabled ? 'configured' : 'disabled',
    auth: cfg.token ? 'static_token' : 'client_credentials',
    tool: cfg.toolName || 'auto'
  };
}

function sessionKey(cfg) {
  const credentialId = cfg.clientId ||
    crypto.createHash('sha256').update(cfg.token).digest('hex').slice(0, 16);
  return `${cfg.url}|${credentialId}|${cfg.scope}`;
}

function mcpHttpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function fetchWithTimeout(url, options, signal) {
  try {
    return await fetch(url, { ...options, signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw new Error('Ansvar MCP request timed out');
    }
    throw err;
  }
}

async function readAccessToken(cfg, signal) {
  if (cfg.token) return cfg.token;

  const cacheKey = `${cfg.tokenUrl}|${cfg.clientId}|${cfg.scope}`;
  if (tokenCache.key === cacheKey && tokenCache.token &&
      Date.now() < tokenCache.expiresAt - 5000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: cfg.scope,
    // RFC 8707 resource indicator; ignored by authorization servers that do
    // not implement it, used by gateways that bind the token to the MCP URL.
    resource: env('ANSVAR_RESOURCE') || cfg.url
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const res = await fetchWithTimeout(cfg.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
      Accept: 'application/json'
    },
    body
  }, signal);

  if (!res.ok) {
    throw mcpHttpError(
      `Ansvar OAuth token request failed (HTTP ${res.status}). Check ANSVAR_CLIENT_ID / ANSVAR_CLIENT_SECRET.`,
      res.status
    );
  }

  const data = await res.json().catch(() => null);
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('Ansvar OAuth token response did not contain an access token');
  }

  const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 60;
  tokenCache = {
    key: cacheKey,
    token: data.access_token,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000
  };
  return tokenCache.token;
}

function parseSseEvent(rawEvent) {
  const dataLines = [];
  for (const rawLine of rawEvent.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch (_err) {
    return null;
  }
}

function findResponse(message, id) {
  if (Array.isArray(message)) {
    return message.find((entry) => entry && entry.id === id) || null;
  }
  return message && message.id === id ? message : null;
}

async function readSseResponse(res, expectedId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = (rawEvent) => {
    if (!rawEvent.trim()) return null;
    const message = parseSseEvent(rawEvent);
    return message ? findResponse(message, expectedId) : null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const message = consume(rawEvent);
        if (message) return message;
        boundary = buffer.indexOf('\n\n');
      }
    }

    if (buffer.trim()) {
      const message = consume(buffer);
      if (message) return message;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  throw new Error('Ansvar MCP SSE stream ended without a JSON-RPC response');
}

async function postRpc(cfg, token, sessionId, payload, signal) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'MCP-Protocol-Version': PROTOCOL_VERSION
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetchWithTimeout(cfg.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, signal);

  const responseSessionId = res.headers.get('mcp-session-id') || sessionId || null;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    const err = mcpHttpError(
      `Ansvar MCP HTTP ${res.status} (${payload.method})${detail}`,
      res.status
    );
    err.sessionId = responseSessionId;
    throw err;
  }

  // JSON-RPC notifications are answered with 202/204 and no body.
  if (payload.id === undefined) {
    await res.text().catch(() => '');
    return { message: null, sessionId: responseSessionId };
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return {
      message: await readSseResponse(res, payload.id),
      sessionId: responseSessionId
    };
  }

  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Ansvar MCP returned an empty response for ${payload.method}`);
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch (_err) {
    throw new Error(`Ansvar MCP returned non-JSON for ${payload.method}`);
  }
  return { message, sessionId: responseSessionId };
}

async function rpcRequest(cfg, token, sessionId, method, params, signal) {
  const id = nextRpcId++;
  const { message, sessionId: responseSessionId } = await postRpc(
    cfg,
    token,
    sessionId,
    { jsonrpc: '2.0', id, method, params },
    signal
  );
  const response = findResponse(message, id);
  if (!response) {
    throw new Error(`Ansvar MCP ${method} response was missing its JSON-RPC id`);
  }
  if (response.error) {
    const reason = response.error.message || response.error.code || 'unknown error';
    throw new Error(`Ansvar MCP ${method} failed: ${reason}`);
  }
  return { result: response.result || {}, sessionId: responseSessionId };
}

async function rpcNotification(cfg, token, sessionId, method, params, signal) {
  await postRpc(cfg, token, sessionId, { jsonrpc: '2.0', method, params }, signal);
}

async function openSession(cfg, token, signal) {
  const key = sessionKey(cfg);
  if (sessionCache && sessionCache.key === key &&
      Date.now() < sessionCache.expiresAt && sessionCache.tools.length > 0) {
    return sessionCache;
  }

  const init = await rpcRequest(cfg, token, null, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO
  }, signal);

  const sessionId = init.sessionId;
  await rpcNotification(cfg, token, sessionId, 'notifications/initialized', {}, signal);

  const listed = await rpcRequest(cfg, token, sessionId, 'tools/list', {}, signal);
  const tools = Array.isArray(listed.result.tools) ? listed.result.tools : [];
  if (tools.length === 0) {
    throw new Error('Ansvar MCP exposed no tools');
  }

  sessionCache = {
    key,
    sessionId,
    tools,
    expiresAt: Date.now() + cfg.sessionTtlMs
  };
  return sessionCache;
}

function chooseTool(tools, cfg) {
  if (cfg.toolName) {
    const pinned = tools.find((tool) => tool && tool.name === cfg.toolName);
    if (!pinned) {
      const available = tools.map((tool) => tool && tool.name).filter(Boolean).join(', ');
      throw new Error(
        `Ansvar tool '${cfg.toolName}' not found. Available tools: ${available || '(none)'}`
      );
    }
    return pinned;
  }

  const searchWords = [
    'search', 'law', 'legislation', 'legal', 'greek', 'greece',
    'nomos', 'statute', 'article', 'retriev', 'lookup'
  ];
  let best = null;
  let bestScore = 0;
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string') continue;
    const text = `${tool.name} ${tool.title || ''} ${tool.description || ''}`.toLowerCase();
    let score = 0;
    for (const word of searchWords) {
      if (text.includes(word)) score += 1;
    }
    if (tool.name.toLowerCase().includes('search')) score += 2;
    if (score > bestScore) {
      best = tool;
      bestScore = score;
    }
  }

  if (!best) {
    const available = tools.map((tool) => tool && tool.name).filter(Boolean).join(', ');
    throw new Error(
      `Could not choose an Ansvar search tool automatically. Set ANSVAR_TOOL_NAME. Available: ${available}`
    );
  }
  return best;
}

function findSchemaProperty(properties, patterns) {
  for (const [name, schema] of Object.entries(properties || {})) {
    if (patterns.some((pattern) => pattern.test(name))) {
      return { name, schema: schema || {} };
    }
  }
  return null;
}

function coerceArgument(value, schema) {
  const type = schema && schema.type;
  if (type === 'array') return [value];
  if (type === 'integer') return Number.parseInt(value, 10);
  if (type === 'number') return Number(value);
  if (type === 'string') return String(value);
  return value;
}

function interpolateTemplate(value, variables) {
  if (value === '{{query}}') return variables.query;
  if (value === '{{limit}}') return variables.limit;
  if (typeof value === 'string') {
    return value
      .replace(/\{\{query\}\}/g, variables.query)
      .replace(/\{\{limit\}\}/g, String(variables.limit));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateTemplate(entry, variables));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = interpolateTemplate(entry, variables);
    }
    return out;
  }
  return value;
}

function buildToolArguments(tool, query, limit, cfg) {
  if (cfg.argsTemplate) {
    let template;
    try {
      template = JSON.parse(cfg.argsTemplate);
    } catch (_err) {
      throw new Error('ANSVAR_TOOL_ARGS is not valid JSON');
    }
    return interpolateTemplate(template, { query, limit });
  }

  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const queryProp =
    findSchemaProperty(properties, [
      /^(query|q|search_query|search|text|term|terms|keyword|keywords|prompt|question|input)$/i,
      /(query|search|prompt|question|text|term)/i
    ]) ||
    required
      .map((name) => ({ name, schema: properties[name] || {} }))
      .find((entry) => entry.schema.type === 'string') ||
    null;

  const args = {};
  if (queryProp) {
    args[queryProp.name] = coerceArgument(query, queryProp.schema);
  } else if (Object.keys(properties).length === 0 || schema.additionalProperties) {
    args.query = query;
  } else {
    throw new Error(
      'Ansvar tool has no recognizable query argument. Set ANSVAR_TOOL_ARGS.'
    );
  }

  const limitProp = findSchemaProperty(properties, [
    /^(limit|top_k|topk|max_results|maxresults|count|page_size|pagesize|k)$/i
  ]);
  if (limitProp) {
    args[limitProp.name] = coerceArgument(limit, limitProp.schema);
  }

  for (const name of required) {
    if (Object.prototype.hasOwnProperty.call(args, name)) continue;
    const schemaForName = properties[name] || {};
    if (schemaForName.default !== undefined) {
      args[name] = schemaForName.default;
      continue;
    }
    throw new Error(
      `Ansvar tool requires unsupported argument '${name}'. Set ANSVAR_TOOL_ARGS.`
    );
  }

  return args;
}

function isUsable(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstString(item, keys) {
  for (const key of keys) {
    const value = item[key];
    if (isUsable(value)) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(item, keys) {
  for (const key of keys) {
    const value = item[key];
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeSimilarity(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const score = raw > 1 && raw <= 100 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object') return [];

  const arrayKeys = [
    'results', 'laws', 'legislation', 'articles', 'documents', 'data',
    'items', 'matches', 'hits', 'sources', 'citations'
  ];
  for (const key of arrayKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  if (payload.data && typeof payload.data === 'object') {
    for (const key of arrayKeys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }

  const content = firstString(payload, [
    'content', 'text', 'snippet', 'summary', 'answer',
    'article_text', 'excerpt', 'body', 'description'
  ]);
  return content ? [payload] : [];
}

function normalizeItem(item) {
  if (typeof item === 'string') {
    const content = item.trim();
    return content ? {
      id: null,
      source_type: 'Ansvar MCP',
      article_number: null,
      title: null,
      content: content.slice(0, MAX_CONTENT_CHARS),
      similarity: null,
      provider: 'ansvar'
    } : null;
  }
  if (!item || typeof item !== 'object') return null;

  const content = firstString(item, [
    'content', 'text', 'snippet', 'summary', 'answer',
    'article_text', 'excerpt', 'body', 'description'
  ]) || JSON.stringify(item);

  if (!isUsable(content)) return null;

  const rawScore = firstNumber(item, [
    'similarity', 'score', 'relevance', 'confidence', 'rank_score'
  ]);
  const rawId = firstNumber(item, ['id', 'article_id', 'law_id', 'document_id']);

  return {
    id: rawId,
    source_type:
      firstString(item, ['source_type', 'sourceType', 'law_type', 'document_type', 'category']) ||
      'Ελληνική νομοθεσία',
    article_number: firstString(item, [
      'article_number', 'articleNumber', 'article_no', 'article_num', 'article'
    ]),
    title: firstString(item, [
      'title', 'name', 'law_title', 'lawTitle', 'document_title', 'documentTitle', 'law', 'act', 'code'
    ]),
    content: content.slice(0, MAX_CONTENT_CHARS),
    similarity: normalizeSimilarity(rawScore),
    provider: 'ansvar'
  };
}

function normalizeToolResult(result, limit) {
  if (!result || typeof result !== 'object') return [];
  if (result.isError) {
    const text = (result.content || [])
      .filter((entry) => entry && entry.type === 'text' && isUsable(entry.text))
      .map((entry) => entry.text)
      .join(' ')
      .slice(0, 300);
    throw new Error(`Ansvar tool returned an error${text ? `: ${text}` : ''}`);
  }

  const payloads = [];
  if (result.structuredContent !== undefined) payloads.push(result.structuredContent);
  const text = (result.content || [])
    .filter((entry) => entry && entry.type === 'text' && isUsable(entry.text))
    .map((entry) => entry.text)
    .join('\n')
    .trim();
  if (text) {
    try {
      payloads.push(JSON.parse(text));
    } catch (_err) {
      payloads.push(text);
    }
  }

  for (const payload of payloads) {
    const items = extractItems(payload);
    if (items.length === 0) continue;
    const normalized = items
      .slice(0, limit)
      .map(normalizeItem)
      .filter(Boolean);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

async function callSearchTool(cfg, token, session, query, limit, signal) {
  const tool = chooseTool(session.tools, cfg);
  const args = buildToolArguments(tool, query, limit, cfg);
  const { result } = await rpcRequest(
    cfg,
    token,
    session.sessionId,
    'tools/call',
    { name: tool.name, arguments: args },
    signal
  );
  return normalizeToolResult(result, limit);
}

async function retrieveLegislation(query, limit = 5) {
  const cfg = getConfig();
  if (!cfg.enabled) return [];

  const effectiveLimit = Math.max(1, Math.min(Number(limit) || 5, 20));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const token = await readAccessToken(cfg, controller.signal);
        const session = await openSession(cfg, token, controller.signal);
        return await callSearchTool(
          cfg, token, session, query, effectiveLimit, controller.signal
        );
      } catch (err) {
        const retryable =
          err && err.status === 401 && !cfg.token && attempt === 1;
        if (!retryable) throw err;
        tokenCache = { key: null, token: null, expiresAt: 0 };
        sessionCache = null;
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Ansvar MCP request timed out after ${cfg.timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function __resetForTests() {
  tokenCache = { key: null, token: null, expiresAt: 0 };
  sessionCache = null;
  nextRpcId = 1;
}

module.exports = {
  isConfigured,
  getStatus,
  retrieveLegislation,
  __resetForTests
};
