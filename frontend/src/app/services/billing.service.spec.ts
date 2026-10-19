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

  it('should fetch a paginated invoice page', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({
        invoices: [{
          id: 9,
          stripe_invoice_id: 'in_9',
          stripe_customer_id: 'cus_1',
          stripe_subscription_id: 'sub_1',
          amount_due: 1900,
          amount_paid: 1900,
          currency: 'eur',
          status: 'paid',
          hosted_invoice_url: 'https://invoice.stripe.com/i/in_9',
          invoice_pdf: 'https://invoice.stripe.com/i/in_9.pdf',
          period_start: '2026-01-01T00:00:00.000Z',
          period_end: '2026-02-01T00:00:00.000Z',
          created_at: '2026-01-01T00:00:00.000Z'
        }],
        total: 25,
        limit: 10,
        offset: 20
      }))
    );

    const page = await service.listInvoices(10, 20);

    const [url, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(url).toContain('/api/subscriptions/invoices?limit=10&offset=20');
    expect(init.method).toBeUndefined();
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token-abc');
    expect(page.total).toBe(25);
    expect(page.offset).toBe(20);
    expect(page.invoices.length).toBe(1);
    expect(page.invoices[0].status).toBe('paid');
  });

  it('should default to the first 10 invoices', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ invoices: [], total: 0, limit: 10, offset: 0 }))
    );

    await service.listInvoices();

    const [url] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(url).toContain('/api/subscriptions/invoices?limit=10&offset=0');
  });

  it('should surface invoice-load failures', async () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve(mockResponse({ error: 'invoices unavailable' }, 503))
    );

    await expectAsync(service.listInvoices()).toBeRejectedWithError('invoices unavailable');
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
