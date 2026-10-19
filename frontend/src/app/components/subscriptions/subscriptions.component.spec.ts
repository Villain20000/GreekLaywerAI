import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { SubscriptionsComponent } from './subscriptions.component';
import {
  BillingService,
  Invoice,
  InvoicePage,
  Subscription,
  SubscriptionState
} from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

function subscriptionStub(id: number, status: string | null = 'active'): Subscription {
  return {
    id,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    status,
    current_period_end: '2026-12-01',
    created_at: '2026-01-01'
  };
}

function invoiceStub(id: number, overrides: Partial<Invoice> = {}): Invoice {
  return {
    id,
    stripe_invoice_id: `in_${id}`,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    amount_due: 1900,
    amount_paid: 1900,
    currency: 'eur',
    status: 'paid',
    hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
    invoice_pdf: 'https://invoice.stripe.com/i/in_1.pdf',
    period_start: '2026-01-01T00:00:00.000Z',
    period_end: '2026-02-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function invoicePage(invoices: Invoice[], total = invoices.length): InvoicePage {
  return { invoices, total, limit: 10, offset: 0 };
}

const activeState: SubscriptionState = {
  subscription: subscriptionStub(1),
  tier: 'pro'
};

const canceledAtPeriodEndState: SubscriptionState = {
  subscription: subscriptionStub(1, 'canceled_at_period_end'),
  tier: 'pro'
};

/** New copy may land in the i18n JSON separately; fall back to the key. */
function copy(key: string): string {
  return lookupTranslation('el', key) ?? key;
}

describe('SubscriptionsComponent', () => {
  let fixture: ComponentFixture<SubscriptionsComponent>;
  let component: SubscriptionsComponent;
  let billingStub: {
    getSubscription: jasmine.Spy;
    history: jasmine.Spy;
    listInvoices: jasmine.Spy;
    cancel: jasmine.Spy;
    reactivate: jasmine.Spy;
  };
  let confirmStub: { ask: jasmine.Spy };

  async function init(): Promise<void> {
    fixture = TestBed.createComponent(SubscriptionsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    confirmStub = { ask: jasmine.createSpy('ask').and.resolveTo(true) };
    billingStub = {
      getSubscription: jasmine.createSpy('getSubscription').and.resolveTo(activeState),
      history: jasmine
        .createSpy('history')
        .and.resolveTo([subscriptionStub(1), subscriptionStub(2, 'canceled')]),
      listInvoices: jasmine
        .createSpy('listInvoices')
        .and.resolveTo(invoicePage([invoiceStub(1)])),
      cancel: jasmine.createSpy('cancel').and.resolveTo(undefined),
      reactivate: jasmine
        .createSpy('reactivate')
        .and.resolveTo({ id: 1, status: 'active' })
    };

    await TestBed.configureTestingModule({
      imports: [SubscriptionsComponent, RouterTestingModule],
      providers: [
        // 2-8: the subscriptions template renders through the translate pipe
        // and the confirm-dialog copy is resolved via TranslateService.instant().
        ...provideTestTranslate(),
        { provide: BillingService, useValue: billingStub },
        { provide: ConfirmService, useValue: confirmStub }
      ]
    }).compileComponents();

    await init();
  });

  it('loads the current subscription, the history and the payment history', () => {
    expect(billingStub.getSubscription).toHaveBeenCalled();
    expect(billingStub.history).toHaveBeenCalled();
    expect(billingStub.listInvoices).toHaveBeenCalledWith(10, 0);
    expect(component.state?.tier).toBe('pro');
    expect(component.history.length).toBe(2);
    expect(component.invoices.length).toBe(1);
    expect(component.invoiceTotal).toBe(1);

    const text = fixture.nativeElement.textContent;
    expect(text).toContain(lookupTranslation('el', 'subscriptions.planLabel')!);
    expect(text).toContain('pro');
    expect(text).toContain('active');
    expect(text).toContain('19.00 EUR');
    expect(text).toContain('paid');
  });

  it('renders invoice links to the hosted invoice and the PDF', () => {
    const hrefs = Array.from(
      fixture.nativeElement.querySelectorAll('a') as NodeListOf<HTMLAnchorElement>
    ).map((link) => link.getAttribute('href'));

    expect(hrefs).toContain('https://invoice.stripe.com/i/in_1');
    expect(hrefs).toContain('https://invoice.stripe.com/i/in_1.pdf');
  });

  it('renders the empty state when there is no subscription', async () => {
    billingStub.getSubscription.and.resolveTo({ subscription: null, tier: 'basic' });
    await init();

    expect(component.state?.subscription).toBeNull();
    expect(fixture.nativeElement.textContent).toContain(
      lookupTranslation('el', 'subscriptions.none')!
    );
  });

  it('renders the empty history row when there is no history', async () => {
    billingStub.history.and.resolveTo([]);
    await init();

    expect(component.history.length).toBe(0);
    expect(fixture.nativeElement.textContent).toContain(
      lookupTranslation('el', 'subscriptions.historyEmpty')!
    );
  });

  it('renders the empty payment history state when there are no invoices', async () => {
    billingStub.listInvoices.and.resolveTo(invoicePage([]));
    await init();

    expect(component.invoices.length).toBe(0);
    expect(fixture.nativeElement.textContent).toContain(copy('subscriptions.paymentHistoryEmpty'));
  });

  it('paginates the payment history with prev / next', async () => {
    billingStub.listInvoices.and.callFake(
      (limit: number, offset: number) => Promise.resolve({
        invoices: [invoiceStub(offset === 0 ? 1 : 2)],
        total: 25,
        limit,
        offset
      })
    );
    await init();

    expect(component.invoicePage).toBe(1);
    expect(component.invoicePages).toBe(3);

    await component.nextInvoicePage();
    expect(billingStub.listInvoices).toHaveBeenCalledWith(10, 10);
    expect(component.invoiceOffset).toBe(10);
    expect(component.invoicePage).toBe(2);

    fixture.detectChanges();
    await component.prevInvoicePage();
    expect(billingStub.listInvoices).toHaveBeenCalledWith(10, 0);
    expect(component.invoiceOffset).toBe(0);
  });

  it('shows the translated payment-history error — never the server prose', async () => {
    billingStub.listInvoices.and.rejectWith(new Error('Invoices failed (HTTP 500)'));
    await init();

    expect(component.invoicesError).toBe(copy('subscriptions.paymentHistoryError'));
    expect(component.invoicesError).not.toContain('Invoices failed');
    expect(fixture.nativeElement.textContent).not.toContain('Invoices failed');
  });

  it('cancels the subscription after the confirmation', async () => {
    await component.cancel();

    expect(confirmStub.ask).toHaveBeenCalledWith(jasmine.objectContaining({
      title: lookupTranslation('el', 'subscriptions.cancelTitle'),
      message: lookupTranslation('el', 'subscriptions.cancelMessage')
    }));
    expect(billingStub.cancel).toHaveBeenCalled();
    expect(billingStub.getSubscription).toHaveBeenCalledTimes(2);
    expect(component.cancelOk).toBe(lookupTranslation('el', 'subscriptions.cancelledOk')!);
    expect(component.error).toBe('');
    expect(component.busy).toBe(false);

    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(
      lookupTranslation('el', 'subscriptions.cancelledOk')!
    );
  });

  it('does not cancel the subscription when the confirmation is dismissed', async () => {
    confirmStub.ask.and.resolveTo(false);

    await component.cancel();

    expect(billingStub.cancel).not.toHaveBeenCalled();
    expect(component.busy).toBe(false);
    expect(component.cancelOk).toBe('');
  });

  it('offers reactivate only for a cancellation scheduled at period end', async () => {
    billingStub.getSubscription.and.returnValues(
      Promise.resolve(canceledAtPeriodEndState),
      Promise.resolve(activeState)
    );
    await init();

    expect(component.canReactivate).toBe(true);
    const button = fixture.nativeElement.querySelector('.nl-reactivate-btn') as HTMLButtonElement;
    expect(button).toBeTruthy();

    await component.reactivate();

    expect(billingStub.reactivate).toHaveBeenCalled();
    expect(component.canReactivate).toBe(false);
    expect(component.reactivateOk).toBe(lookupTranslation('el', 'billing.reactivatedOk')!);
    expect(component.error).toBe('');
    expect(component.busy).toBe(false);
  });

  it('hides reactivate for an active subscription', () => {
    expect(component.canReactivate).toBe(false);
    expect(fixture.nativeElement.querySelector('.nl-reactivate-btn')).toBeNull();
  });

  it('shows the translated reactivate error — never the server prose', async () => {
    billingStub.getSubscription.and.resolveTo(canceledAtPeriodEndState);
    billingStub.reactivate.and.rejectWith(new Error('Reactivate failed (HTTP 500)'));
    await init();

    await component.reactivate();

    expect(component.error).toBe(lookupTranslation('el', 'billing.reactivateError')!);
    expect(component.error).not.toContain('Reactivate failed');
    expect(component.reactivateOk).toBe('');
    expect(component.busy).toBe(false);
  });

  // ------------------------------------------------------------------
  // Error channels: the server's English prose is logged, never rendered.
  // ------------------------------------------------------------------

  it('shows the translated load copy — never the server prose', async () => {
    billingStub.getSubscription.and.rejectWith(
      new Error('Get subscription failed (HTTP 500)')
    );
    await init();

    expect(component.error).toBe(lookupTranslation('el', 'subscriptions.loadError')!);
    expect(component.error).not.toContain('Get subscription failed');
    expect(fixture.nativeElement.textContent).not.toContain('Get subscription failed');
  });

  it('shows the translated cancel copy — never the server prose', async () => {
    billingStub.cancel.and.rejectWith(new Error('Cancel failed (HTTP 500)'));

    await component.cancel();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'subscriptions.cancelError')!);
    expect(component.error).not.toContain('Cancel failed');
    expect(fixture.nativeElement.textContent).not.toContain('Cancel failed');
    expect(component.cancelOk).toBe('');
    expect(component.busy).toBe(false);
  });
});
