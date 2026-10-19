import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { SubscriptionsComponent } from './subscriptions.component';
import { BillingService, Subscription, SubscriptionState } from '../../services/billing.service';
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

const activeState: SubscriptionState = {
  subscription: subscriptionStub(1),
  tier: 'pro'
};

describe('SubscriptionsComponent', () => {
  let fixture: ComponentFixture<SubscriptionsComponent>;
  let component: SubscriptionsComponent;
  let billingStub: {
    getSubscription: jasmine.Spy;
    history: jasmine.Spy;
    cancel: jasmine.Spy;
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
      cancel: jasmine.createSpy('cancel').and.resolveTo(undefined)
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

  it('loads the current subscription and the history', () => {
    expect(billingStub.getSubscription).toHaveBeenCalled();
    expect(billingStub.history).toHaveBeenCalled();
    expect(component.state?.tier).toBe('pro');
    expect(component.history.length).toBe(2);

    const text = fixture.nativeElement.textContent;
    expect(text).toContain(lookupTranslation('el', 'subscriptions.planLabel')!);
    expect(text).toContain('pro');
    expect(text).toContain('active');
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
