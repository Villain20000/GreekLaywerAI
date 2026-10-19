import { TestBed } from '@angular/core/testing';
import { BillingService } from './billing.service';

describe('BillingService', () => {
  let service: BillingService;
  let originalFetch: typeof fetch;

  function mockResponse(body: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body)
    } as Response;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BillingService] });
    service = TestBed.inject(BillingService);
    localStorage.setItem('nomos_token', 'test-token-abc');

    originalFetch = window.fetch;
    window.fetch = jasmine.createSpy('fetch') as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    localStorage.removeItem('nomos_token');
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should fetch the server-owned plan catalog', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({
        plans: [{
          id: 'pro',
          tier: 'pro',
          name: 'Pro',
          price: '19 € / μήνα',
          features: ['60 ερωτήματα AI / ημέρα'],
          recommended: true
        }]
      }))
    );

    const plans = await service.getPlans();

    const [url, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(url).toContain('/api/billing/plans');
    expect(init.method).toBeUndefined();
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token-abc');
    expect(plans.length).toBe(1);
    expect(plans[0].tier).toBe('pro');
    expect(plans[0].recommended).toBe(true);
  });

  it('should surface plan-load failures', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ error: 'nope' }, 500))
    );

    await expectAsync(service.getPlans()).toBeRejectedWithError('nope');
  });

  it('should POST to /api/billing/portal and return the portal URL', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ url: 'https://billing.stripe.com/session/1' }))
    );

    const url = await service.createPortalSession();

    const [requestUrl, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(requestUrl).toContain('/api/billing/portal');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(url).toBe('https://billing.stripe.com/session/1');
  });

  it('should surface the mock-mode 403 message from /api/billing/portal', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ error: 'Customer portal is only available in live Stripe mode' }, 403))
    );

    await expectAsync(service.createPortalSession())
      .toBeRejectedWithError(/live Stripe mode/);
  });

  it('should POST to /api/subscriptions/reactivate and return the subscription', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ ok: true, subscription: { id: 7, status: 'active' } }))
    );

    const subscription = await service.reactivate();

    const [url, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(url).toContain('/api/subscriptions/reactivate');
    expect(init.method).toBe('POST');
    expect(subscription?.status).toBe('active');
  });

  it('should surface reactivate failures', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ error: 'Subscription has already ended' }, 409))
    );

    await expectAsync(service.reactivate())
      .toBeRejectedWithError(/already ended/);
  });

  it('should no longer expose the dead upgrade() helper', () => {
    expect((service as unknown as { upgrade?: unknown }).upgrade).toBeUndefined();
  });
});
