process.env.NODE_ENV = 'test';

const http = require('http');
const ansvarMcpService = require('../src/services/ansvarMcpService');

const SESSION_ID = 'sess-test-1';
const TOKEN = 'test-access-token';

let server;
let baseUrl;
let requests;
let mcpCalls;

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function toolResult(messageId) {
  return {
    jsonrpc: '2.0',
    id: messageId,
    result: {
      structuredContent: {
        results: [
          {
            id: '585',
            title: 'Αστικός Κώδικας',
            article_number: '585',
            source_type: 'Νόμος',
            content: 'Η καταγγελία της μισθώσεως γίνεται εγγράφως.',
            score: 91
          },
          {
            id: '595',
            title: 'Αστικός Κώδικας',
            article_number: '595',
            source_type: 'Νόμος',
            content: 'Η μίσθωση λήγει με την πάροδο του χρόνου.',
            score: 0.84
          }
        ]
      }
    }
  };
}

function startServer() {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/token') {
        requests.push({
          kind: 'token',
          authorization: req.headers.authorization,
          body: raw
        });
        return json(res, 200, {
          access_token: TOKEN,
          token_type: 'Bearer',
          expires_in: 3600
        });
      }

      if (req.url === '/mcp') {
        let message;
        try {
          message = JSON.parse(raw);
        } catch (_err) {
          return json(res, 400, { error: 'invalid json' });
        }

        requests.push({
          kind: 'mcp',
          method: message.method,
          sessionId: req.headers['mcp-session-id'] || null,
          authorization: req.headers.authorization,
          message
        });
        if (message.id !== undefined) mcpCalls.push(message.method);

        if (message.method === 'initialize') {
          return json(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-ansvar', version: '1.0.0' }
            }
          }, { 'mcp-session-id': SESSION_ID });
        }

        if (message.method === 'notifications/initialized') {
          res.statusCode = 202;
          return res.end();
        }

        if (message.method === 'tools/list') {
          return json(res, 200, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'health_check',
                  description: 'Returns gateway health; not a search tool.'
                },
                {
                  name: 'greek_legislation_search',
                  description: 'Search Greek laws and return matching articles.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      query: { type: 'string' },
                      limit: { type: 'integer' }
                    },
                    required: ['query']
                  }
                }
              ]
            }
          });
        }

        if (message.method === 'tools/call') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'mcp-session-id': SESSION_ID
          });
          res.write('event: message\n');
          res.write(`data: ${JSON.stringify(toolResult(message.id))}\n\n`);
          return res.end();
        }

        return json(res, 400, { error: `unexpected method ${message.method}` });
      }

      res.statusCode = 404;
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function configure(overrides = {}) {
  process.env.ANSVAR_MCP_URL = `${baseUrl}/mcp`;
  process.env.ANSVAR_TOKEN_URL = `${baseUrl}/token`;
  process.env.ANSVAR_CLIENT_ID = 'nomosai-test-client';
  process.env.ANSVAR_CLIENT_SECRET = 'nomosai-test-secret';
  process.env.ANSVAR_SCOPE = 'mcp:tools';
  process.env.ANSVAR_MCP_ENABLED = 'true';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearAnsvarEnv() {
  for (const key of [
    'ANSVAR_MCP_URL', 'ANSVAR_TOKEN_URL', 'ANSVAR_CLIENT_ID',
    'ANSVAR_CLIENT_SECRET', 'ANSVAR_MCP_TOKEN', 'ANSVAR_MCP_ENABLED',
    'ANSVAR_SCOPE', 'ANSVAR_TOOL_NAME', 'ANSVAR_TOOL_ARGS',
    'ANSVAR_TIMEOUT_MS', 'ANSVAR_SESSION_TTL_MS'
  ]) {
    delete process.env[key];
  }
}

beforeAll(startServer);
afterAll(async () => {
  clearAnsvarEnv();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  clearAnsvarEnv();
  ansvarMcpService.__resetForTests();
  requests = [];
  mcpCalls = [];
});

describe('ansvarMcpService', () => {
  it('stays disabled without credentials', async () => {
    expect(ansvarMcpService.isConfigured()).toBe(false);
    await expect(ansvarMcpService.retrieveLegislation('νόμος')).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('runs client_credentials + MCP handshake and normalizes a Greek-law result', async () => {
    configure();

    const documents = await ansvarMcpService.retrieveLegislation('καταγγελία μίσθωσης', 3);

    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      id: 585,
      title: 'Αστικός Κώδικας',
      source_type: 'Νόμος',
      article_number: '585',
      provider: 'ansvar'
    });
    expect(documents[0].similarity).toBe(0.91);
    expect(documents[1].similarity).toBe(0.84);

    const tokenRequest = requests.find((entry) => entry.kind === 'token');
    expect(tokenRequest.authorization).toBe(
      `Basic ${Buffer.from('nomosai-test-client:nomosai-test-secret').toString('base64')}`
    );
    expect(tokenRequest.body).toContain('grant_type=client_credentials');
    expect(tokenRequest.body).toContain('scope=mcp%3Atools');

    const mcpRequests = requests.filter((entry) => entry.kind === 'mcp');
    expect(mcpRequests.map((entry) => entry.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call'
    ]);
    expect(mcpRequests[0].sessionId).toBeNull();
    expect(mcpRequests[1].sessionId).toBe(SESSION_ID);
    expect(mcpRequests[2].sessionId).toBe(SESSION_ID);
    expect(mcpRequests[3].sessionId).toBe(SESSION_ID);
    expect(mcpRequests[0].authorization).toBe(`Bearer ${TOKEN}`);

    const call = mcpRequests[3].message;
    expect(call.params.name).toBe('greek_legislation_search');
    expect(call.params.arguments).toEqual({
      query: 'καταγγελία μίσθωσης',
      limit: 3
    });
  });

  it('reuses the token and MCP session across retrievals', async () => {
    configure();

    await ansvarMcpService.retrieveLegislation('πρώτη ερώτηση');
    await ansvarMcpService.retrieveLegislation('δεύτερη ερώτηση');

    expect(requests.filter((entry) => entry.kind === 'token')).toHaveLength(1);
    expect(mcpCalls.filter((method) => method === 'initialize')).toHaveLength(1);
    expect(mcpCalls.filter((method) => method === 'tools/list')).toHaveLength(1);
    expect(mcpCalls.filter((method) => method === 'tools/call')).toHaveLength(2);
  });

  it('supports a static bearer token without calling the OAuth endpoint', async () => {
    configure({
      ANSVAR_MCP_TOKEN: 'static-token',
      ANSVAR_CLIENT_ID: null,
      ANSVAR_CLIENT_SECRET: null
    });

    await ansvarMcpService.retrieveLegislation('Αστικός Κώδικας');

    expect(requests.some((entry) => entry.kind === 'token')).toBe(false);
    const calls = requests.filter((entry) => entry.kind === 'mcp');
    expect(calls[0].authorization).toBe('Bearer static-token');
  });

  it('accepts an explicit tool argument template for gateway schemas', async () => {
    configure({
      ANSVAR_TOOL_NAME: 'greek_legislation_search',
      ANSVAR_TOOL_ARGS: JSON.stringify({
        query: '{{query}}',
        limit: '{{limit}}',
        jurisdiction: 'GR'
      })
    });

    await ansvarMcpService.retrieveLegislation('μισθωτική σύμβαση', 2);

    const call = requests.find(
      (entry) => entry.kind === 'mcp' && entry.method === 'tools/call'
    );
    expect(call.message.params.arguments).toEqual({
      query: 'μισθωτική σύμβαση',
      limit: 2,
      jurisdiction: 'GR'
    });
  });
});
