import {
  AB_CLIENT_STORAGE_KEY,
  CONTROL_VARIANT,
  ExperimentService,
  hashString,
  pickVariant,
  sanitizeExperiments
} from './experiment.service';

describe('ExperimentService', () => {
  let originalFetch: typeof fetch;

  function mockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body)
    } as Response;
  }

  function stubFetch(body: unknown, status = 200): void {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse(body, status))
    );
  }

  beforeEach(() => {
    originalFetch = window.fetch;
    window.fetch = jasmine.createSpy('fetch') as unknown as typeof fetch;
    localStorage.removeItem(AB_CLIENT_STORAGE_KEY);
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem(AB_CLIENT_STORAGE_KEY);
  });

  it('fetches /api/config once, without an Authorization header', async () => {
    stubFetch({ experiments: { 'landing-hero': { variants: { control: 100 } } } });

    const service = new ExperimentService();
    await service.ready();
    await service.ready();

    const fetchSpy = window.fetch as jasmine.Spy;
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.calls.mostRecent().args;
    expect(url).toContain('/api/config');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(service.getVariant('landing-hero')).toBe('control');
  });

  it('returns the configured variant for a single-variant experiment', async () => {
    stubFetch({ experiments: { 'landing-hero': { variants: { variant: 100 } } } });

    const service = new ExperimentService();
    await service.ready();

    expect(service.getVariant('landing-hero')).toBe('variant');
  });

  it('defaults to control when the request fails or returns non-2xx', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(Promise.reject(new Error('offline')));
    const offline = new ExperimentService();
    await offline.ready();
    expect(offline.getVariant('landing-hero')).toBe(CONTROL_VARIANT);

    stubFetch({ error: 'down' }, 503);
    const unavailable = new ExperimentService();
    await unavailable.ready();
    expect(unavailable.getVariant('landing-hero')).toBe(CONTROL_VARIANT);
  });

  it('defaults to control for missing or malformed experiment payloads', async () => {
    stubFetch({ features: {} });
    const missing = new ExperimentService();
    await missing.ready();
    expect(missing.getVariant('landing-hero')).toBe(CONTROL_VARIANT);

    stubFetch({
      experiments: { 'landing-hero': { variants: { control: -1, variant: '50' } } }
    });
    const malformed = new ExperimentService();
    await malformed.ready();
    expect(malformed.getVariant('landing-hero')).toBe(CONTROL_VARIANT);
    expect(malformed.getVariant('unknown-experiment')).toBe(CONTROL_VARIANT);
  });

  it('persists and reuses an anonymous client id', async () => {
    const first = new ExperimentService().getClientId();

    expect(first.length).toBeGreaterThan(0);
    expect(localStorage.getItem(AB_CLIENT_STORAGE_KEY)).toBe(first);
    expect(new ExperimentService().getClientId()).toBe(first);

    localStorage.setItem(AB_CLIENT_STORAGE_KEY, 'fixed-client-id');
    expect(new ExperimentService().getClientId()).toBe('fixed-client-id');
  });

  it('keeps working when storage is unavailable', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('denied');
    spyOn(Storage.prototype, 'setItem').and.throwError('denied');

    const service = new ExperimentService();
    const id = service.getClientId();

    expect(id.length).toBeGreaterThan(0);
    expect(service.getClientId()).toBe(id);
  });

  it('assigns deterministically for the same client and experiment', () => {
    localStorage.setItem(AB_CLIENT_STORAGE_KEY, 'stable-client');

    const definition = { variants: { control: 50, variant: 50 } };
    const first = pickVariant('stable-client', 'landing-hero', definition);

    expect(['control', 'variant']).toContain(first);
    expect(pickVariant('stable-client', 'landing-hero', definition)).toBe(first);
    expect(hashString('stable-client:landing-hero')).toBe(
      hashString('stable-client:landing-hero')
    );
    expect(hashString('stable-client:landing-hero') % 100).toBeGreaterThanOrEqual(0);
    expect(hashString('stable-client:landing-hero') % 100).toBeLessThan(100);
  });

  it('respects weighted bounds across many clients', () => {
    const definition = { variants: { control: 90, variant: 10 } };
    const total = 10_000;
    let variantCount = 0;

    for (let index = 0; index < total; index += 1) {
      const picked = pickVariant(`client-${index}`, 'landing-hero', definition);
      expect(['control', 'variant']).toContain(picked);
      if (picked === 'variant') variantCount += 1;
    }

    expect(variantCount).toBeGreaterThan(total * 0.03);
    expect(variantCount).toBeLessThan(total * 0.18);
  });

  it('sanitizes experiment config and keeps only positive numeric weights', () => {
    const parsed = sanitizeExperiments({
      'landing-hero': {
        variants: { control: 50, variant: 50, broken: 0, text: '10' }
      },
      invalid: { variants: [] },
      empty: { variants: {} }
    });

    expect(parsed).toEqual({
      'landing-hero': { variants: { control: 50, variant: 50 } }
    });
  });
});
