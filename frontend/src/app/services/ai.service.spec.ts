import { TestBed } from '@angular/core/testing';
import { AiService, RESPONSE_TIMEOUT_NOTICE } from './ai.service';
import { QuotaExceededError } from './quota.service';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response;
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('AiService', () => {
  let service: AiService;
  let originalFetch: typeof fetch;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AiService);

    originalFetch = window.fetch;
    fetchSpy = jasmine.createSpy('fetch');
    window.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should have streamQuery method', () => {
    expect(typeof service.streamQuery).toBe('function');
  });

  it('should have uploadAudio method', () => {
    expect(typeof service.uploadAudio).toBe('function');
  });

  it('cancels the queued job and aborts polling when the subscription is stopped', async () => {
    service.pollIntervalMs = 10000;
    fetchSpy.and.callFake((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true }));
      if (url.endsWith('/query/stream')) return Promise.resolve(jsonResponse({ jobId: 'job-1' }, 202));
      if (url.endsWith('/query/stream/job-1')) return Promise.resolve(jsonResponse({ status: 'pending' }));
      return Promise.resolve(jsonResponse({}));
    });

    const subscription = service.streamQuery('ερώτηση').subscribe();
    await flush();
    await flush();

    subscription.unsubscribe();
    await flush();

    const calls = fetchSpy.calls.all();
    const deleteCall = calls.find(call => call.args[1]?.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall!.args[0])).toContain('/api/ai/query/stream/job-1');

    const pollCall = calls.find(call => String(call.args[0]).endsWith('/query/stream/job-1'));
    expect(pollCall).toBeDefined();
    expect((pollCall!.args[1] as RequestInit).signal?.aborted).toBeTrue();
  });

  it('cancelJob() sends DELETE to the cancel endpoint', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ ok: true })));

    await service.cancelJob('job-9');

    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(String(url)).toContain('/api/ai/query/stream/job-9');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('emits a slow/pending notification before the final answer', async () => {
    service.pollIntervalMs = 5;
    service.pollMaxAttempts = 10;
    service.pollTimeoutMs = 10000;
    service.slowAfterMs = 0;

    let pollCount = 0;
    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/query/stream')) return Promise.resolve(jsonResponse({ jobId: 'job-2' }, 202));
      pollCount += 1;
      if (pollCount === 1) return Promise.resolve(jsonResponse({ status: 'pending' }));
      return Promise.resolve(jsonResponse({
        status: 'completed',
        result: 'τελική απάντηση',
        messageId: 77,
        sources: [],
        confidence: 0.5
      }));
    });

    const emissions: Array<{ pending?: boolean; content: string }> = [];
    service.streamQuery('ερώτηση').subscribe(answer => emissions.push(answer));
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(emissions.length).toBe(2);
    expect(emissions[0].pending).toBeTrue();
    expect(emissions[1].content).toBe('τελική απάντηση');
    expect(emissions[1].pending).toBeUndefined();
  });

  it('fails with the language-neutral timeout sentinel after the attempt budget is exhausted', async () => {
    service.pollIntervalMs = 1;
    service.pollMaxAttempts = 2;
    service.pollTimeoutMs = 10000;

    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/query/stream')) return Promise.resolve(jsonResponse({ jobId: 'job-3' }, 202));
      return Promise.resolve(jsonResponse({ status: 'pending' }));
    });

    let received: Error | null = null;
    service.streamQuery('ερώτηση').subscribe({ error: err => { received = err; } });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(received).not.toBeNull();
    expect(received!.message).toBe(RESPONSE_TIMEOUT_NOTICE);
    // The sentinel is language-neutral: a service layer must not hard-code
    // one language, and the chat renders the translated copy instead.
    expect(/[\u0370-\u03FF]/.test(RESPONSE_TIMEOUT_NOTICE)).toBeFalse();

    const pollCalls = fetchSpy.calls.all().filter(call => String(call.args[0]).endsWith('/query/stream/job-3'));
    expect(pollCalls.length).toBe(2);
  });

  it('surfaces a quota error when the enqueue is rejected with HTTP 429', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      error: 'Daily AI query limit reached for your plan',
      limit: 20,
      used: 20,
      tier: 'basic',
      resetAt: '2026-01-02T00:00:00.000Z'
    }, 429)));

    let received: Error | null = null;
    service.streamQuery('ερώτηση').subscribe({ error: err => { received = err; } });
    await flush();

    expect(received).toBeInstanceOf(QuotaExceededError);
    const quotaError = received as unknown as QuotaExceededError;
    expect(quotaError.kind).toBe('ai');
    expect(quotaError.limit).toBe(20);
    expect(quotaError.used).toBe(20);
    expect(quotaError.tier).toBe('basic');
    expect(quotaError.resetAt).toBe('2026-01-02T00:00:00.000Z');
    expect((quotaError as unknown as { stage?: string }).stage).toBe('enqueue');
  });

  it('surfaces a quota error when the poll is rejected with a quota-shaped HTTP 429 (forward-compatibility guard)', async () => {
    // The poll route (GET /api/ai/query/stream/:jobId) carries NO quota
    // middleware today — `enforceAiQuota` is mounted on /query,
    // /query/stream, /audio-query and /multimodal only — so the backend
    // cannot currently produce this body here. The client handles it
    // defensively anyway: if the backend ever mounts the quota middleware
    // on the poll route, the exhausted allowance must be reported as such
    // instead of a generic failure.
    service.pollIntervalMs = 1;
    service.pollMaxAttempts = 5;
    service.pollTimeoutMs = 10000;

    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/query/stream')) return Promise.resolve(jsonResponse({ jobId: 'job-4' }, 202));
      return Promise.resolve(jsonResponse({
        error: 'Daily AI query limit reached for your plan',
        limit: 20,
        used: 20,
        tier: 'basic',
        resetAt: '2026-01-02T00:00:00.000Z'
      }, 429));
    });

    let received: Error | null = null;
    service.streamQuery('ερώτηση').subscribe({ error: err => { received = err; } });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(received).toBeInstanceOf(QuotaExceededError);
    const quotaError = received as unknown as QuotaExceededError;
    expect(quotaError.kind).toBe('ai');
    expect(quotaError.limit).toBe(20);
    expect((quotaError as unknown as { stage?: string }).stage).toBe('poll');
  });

  it('does NOT report a rate-limit 429 on the poll path as a quota error', async () => {
    // A poll-path 429 that is NOT quota-shaped (no limit/used — which is
    // what the generic rate limiter sends) must surface as the generic
    // error, not as an exhausted allowance.
    service.pollIntervalMs = 1;
    service.pollMaxAttempts = 5;
    service.pollTimeoutMs = 10000;

    fetchSpy.and.callFake((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/query/stream')) return Promise.resolve(jsonResponse({ jobId: 'job-5' }, 202));
      return Promise.resolve(jsonResponse({
        error: 'Too many requests, please try again later.'
      }, 429));
    });

    let received: Error | null = null;
    service.streamQuery('ερώτηση').subscribe({ error: err => { received = err; } });
    await new Promise(resolve => setTimeout(resolve, 80));

    expect(received).not.toBeNull();
    expect(received!).not.toBeInstanceOf(QuotaExceededError);
    expect(received!.message).toBe('Poll failed (HTTP 429)');
  });

  it('keeps a generic error for a non-quota enqueue failure', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ error: 'boom' }, 500)));

    let received: Error | null = null;
    service.streamQuery('ερώτηση').subscribe({ error: err => { received = err; } });
    await flush();

    expect(received).not.toBeNull();
    expect(received!).not.toBeInstanceOf(QuotaExceededError);
    expect(received!.message).toBe('Enqueue failed (HTTP 500)');
  });
});
