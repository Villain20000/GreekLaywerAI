import { TestBed } from '@angular/core/testing';
import {
  consumedQuotaUsed,
  parseQuotaError,
  QuotaExceededError,
  QuotaService,
  QuotaUsage
} from './quota.service';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  } as unknown as Response;
}

/** Body of the backend's 429 (daily AI quota) response. */
const AI_QUOTA_BODY = {
  error: 'Daily AI query limit reached for your plan',
  limit: 20,
  used: 20,
  tier: 'basic',
  resetAt: '2026-01-02T00:00:00.000Z'
};

/** Body of the backend's 403 (document cap) response — no resetAt. */
const DOCUMENT_CAP_BODY = {
  error: 'Document limit reached for your plan',
  limit: 10,
  used: 10,
  tier: 'pro'
};

describe('QuotaService', () => {
  let service: QuotaService;
  let originalFetch: typeof fetch;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(QuotaService);

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

  it('parses a 429 body into an AI quota error', () => {
    const error = parseQuotaError(AI_QUOTA_BODY, 'ai');

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error!.kind).toBe('ai');
    expect(error!.limit).toBe(20);
    expect(error!.used).toBe(20);
    expect(error!.tier).toBe('basic');
    expect(error!.resetAt).toBe('2026-01-02T00:00:00.000Z');
    expect(error!.serverError).toBe('Daily AI query limit reached for your plan');
    expect(error!.hasCounts).toBeTrue();
    expect(error!.canUpgrade).toBeTrue();
  });

  it('parses a 403 body into a document-cap error without a reset time', () => {
    const error = parseQuotaError(DOCUMENT_CAP_BODY, 'documents');

    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error!.kind).toBe('documents');
    expect(error!.limit).toBe(10);
    expect(error!.used).toBe(10);
    expect(error!.tier).toBe('pro');
    expect(error!.resetAt).toBeNull();
  });

  it('returns null for a malformed body', () => {
    expect(parseQuotaError(null, 'ai')).toBeNull();
    expect(parseQuotaError('nope', 'ai')).toBeNull();
    expect(parseQuotaError({}, 'ai')).toBeNull();
    expect(parseQuotaError({ error: 'boom' }, 'ai')).toBeNull();
    expect(parseQuotaError({ error: 'boom', limit: '20', used: 20 }, 'ai')).toBeNull();
  });

  it('keeps a null limit as "unlimited" instead of coercing it to 0', () => {
    const error = parseQuotaError({
      error: 'Daily AI query limit reached for your plan',
      limit: null,
      used: 12,
      tier: 'enterprise',
      resetAt: '2026-01-02T00:00:00.000Z'
    }, 'ai');

    expect(error).not.toBeNull();
    expect(error!.limit).toBeNull();
    expect(error!.used).toBe(12);
    expect(error!.hasCounts).toBeFalse();
    // Enterprise is unlimited, so there is nothing to upgrade to.
    expect(error!.canUpgrade).toBeFalse();
  });

  it('exposes the parser as a service method too', () => {
    expect(service.parseError(AI_QUOTA_BODY, 'ai')).toBeInstanceOf(QuotaExceededError);
    expect(service.parseError({ nope: true }, 'ai')).toBeNull();
  });

  it('fetches the usage projection from GET /api/subscriptions/usage', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      tier: 'basic',
      ai: { used: 3, limit: 20, resetAt: '2026-01-02T00:00:00.000Z' },
      documents: { used: 2, limit: 10 }
    })));

    const usage: QuotaUsage = await service.getUsage();

    expect(String(fetchSpy.calls.mostRecent().args[0])).toBe('/api/subscriptions/usage');
    expect(usage.tier).toBe('basic');
    expect(usage.ai.used).toBe(3);
    expect(usage.ai.limit).toBe(20);
    expect(usage.ai.resetAt).toBe('2026-01-02T00:00:00.000Z');
    expect(usage.documents.used).toBe(2);
    expect(usage.documents.limit).toBe(10);
  });

  it('reports a null limit as unlimited in the usage projection', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      tier: 'enterprise',
      ai: { used: 7, limit: null, resetAt: null },
      documents: { used: 12, limit: null }
    })));

    const usage = await service.getUsage();

    expect(usage.ai.limit).toBeNull();
    expect(usage.documents.limit).toBeNull();
    expect(usage.ai.used).toBe(7);
  });

  it('keeps an absent limit as UNKNOWN, never as unlimited', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      tier: 'basic',
      ai: { used: 3, resetAt: null },
      documents: { used: 2 }
    })));

    const usage = await service.getUsage();

    // `undefined` = the field was not reported. It must NOT collapse into
    // `null` (unlimited): the UI would then claim an unlimited allowance
    // it knows nothing about.
    expect(usage.ai.limit).toBeUndefined();
    expect(usage.documents.limit).toBeUndefined();
  });

  it('keeps a malformed limit as UNKNOWN, never as unlimited', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({
      tier: 'basic',
      ai: { used: 3, limit: 'twenty', resetAt: null },
      documents: { used: 2, limit: {} }
    })));

    const usage = await service.getUsage();

    expect(usage.ai.limit).toBeUndefined();
    expect(usage.documents.limit).toBeUndefined();
  });

  it('clamps the consumed allowance to the limit (never renders "21/20")', async () => {
    // The backend counts the rejected attempt too, so the refusal reports
    // `used: 21` against `limit: 20`.
    expect(consumedQuotaUsed(21, 20)).toBe(20);
    expect(consumedQuotaUsed(5, 20)).toBe(5);
    expect(consumedQuotaUsed(20, 20)).toBe(20);
    // An unknown limit leaves the count untouched; an unknown count stays
    // unknown.
    expect(consumedQuotaUsed(12, null)).toBe(12);
    expect(consumedQuotaUsed(null, 20)).toBeNull();
  });

  it('throws when the usage request fails', async () => {
    fetchSpy.and.returnValue(Promise.resolve(jsonResponse({ error: 'boom' }, 500)));

    await expectAsync(service.getUsage()).toBeRejectedWithError('boom');
  });
});
