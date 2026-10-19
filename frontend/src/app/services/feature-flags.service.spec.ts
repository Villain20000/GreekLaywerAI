import { TestBed } from '@angular/core/testing';
import { FeatureFlagsService } from './feature-flags.service';

describe('FeatureFlagsService', () => {
  let originalFetch: typeof fetch;

  function mockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body)
    } as Response;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    localStorage.removeItem('nomos_token');
    originalFetch = window.fetch;
    window.fetch = jasmine.createSpy('fetch') as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem('nomos_token');
  });

  it('fetches /api/config once, without an Authorization header', async () => {
    localStorage.setItem('nomos_token', 'should-not-be-sent');
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ features: { documents: false } }))
    );

    const service = TestBed.inject(FeatureFlagsService);
    await service.ensureLoaded();
    await service.ensureLoaded();

    const fetchSpy = window.fetch as jasmine.Spy;
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(url).toContain('/api/config');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(service.isEnabled('documents')).toBeFalse();
    localStorage.removeItem('nomos_token');
  });

  it('defaults every flag to enabled and tolerates unknown flags', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ features: { billing: true, documents: true } }))
    );

    const service = TestBed.inject(FeatureFlagsService);
    await service.ensureLoaded();

    expect(service.isEnabled('documents')).toBeTrue();
    expect(service.isEnabled('audio')).toBeTrue();
    expect(service.isEnabled('adminDocuments')).toBeTrue();
    expect(service.isEnabled('not-a-real-flag')).toBeTrue();
    expect(service.flags().billing).toBeTrue();
  });

  it('keeps defaults when the request rejects', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(Promise.reject(new Error('offline')));

    const service = TestBed.inject(FeatureFlagsService);
    await service.ensureLoaded();

    expect(service.isEnabled('documents')).toBeTrue();
    expect(service.isEnabled('billing')).toBeTrue();
  });

  it('keeps defaults on a non-2xx response', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ error: 'down' }, 503))
    );

    const service = TestBed.inject(FeatureFlagsService);
    await service.ensureLoaded();

    expect(service.isEnabled('adminDocuments')).toBeTrue();
  });

  it('ignores non-boolean feature values', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ features: { documents: 'false', billing: false } }))
    );

    const service = TestBed.inject(FeatureFlagsService);
    await service.ensureLoaded();

    expect(service.isEnabled('documents')).toBeTrue();
    expect(service.isEnabled('billing')).toBeFalse();
  });
});
