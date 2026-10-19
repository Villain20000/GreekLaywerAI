import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { BillingComponent } from './billing.component';
import { provideTestTranslate, lookupTranslation } from '../../i18n/testing';
import {
  BillingService,
  SubscriptionState,
  TierPlan
} from '../../services/billing.service';

describe('BillingComponent', () => {
  let fixture: ComponentFixture<BillingComponent>;
  let component: BillingComponent;
  let billingStub: jasmine.SpyObj<BillingService>;
  let routerStub: { navigate: jasmine.Spy };
  let checkoutParam: string | null;

  const apiPlans: TierPlan[] = [
    {
      id: 'basic',
      tier: 'basic',
      name: 'API Basic',
      price: 'Δωρεάν',
      features: ['20 ερωτήματα AI / ημέρα'],
      recommended: false
    },
    {
      id: 'pro',
      tier: 'pro',
      name: 'API Pro',
      price: '19 € / μήνα',
      features: ['60 ερωτήματα AI / ημέρα', 'Απεριόριστα έγγραφα'],
      recommended: true
    }
  ];

  const activeState: SubscriptionState = {
    subscription: {
      id: 1,
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      status: 'active',
      current_period_end: '2026-12-01',
      created_at: '2026-01-01'
    },
    tier: 'pro'
  };

  const canceledState: SubscriptionState = {
    subscription: { ...activeState.subscription!, status: 'canceled_at_period_end' },
    tier: 'pro'
  };

  async function init(): Promise<void> {
    fixture = TestBed.createComponent(BillingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    checkoutParam = null;
    billingStub = jasmine.createSpyObj<BillingService>('BillingService', [
      'getPlans',
      'getSubscription',
      'createCheckoutSession',
      'createPortalSession',
      'reactivate'
    ]);
    billingStub.getPlans.and.resolveTo(apiPlans);
    billingStub.getSubscription.and.resolveTo(activeState);

    routerStub = { navigate: jasmine.createSpy('navigate') };

    await TestBed.configureTestingModule({
      imports: [BillingComponent],
      providers: [
        { provide: BillingService, useValue: billingStub },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: {
                get: (key: string) => (key === 'checkout' ? checkoutParam : null)
              }
            }
          }
        },
        { provide: Router, useValue: routerStub },
        ...provideTestTranslate()
      ]
    }).compileComponents();

    await init();
  });

  it('renders plans from the API catalog instead of a hardcoded list', () => {
    expect(billingStub.getPlans).toHaveBeenCalled();
    expect(component.plans).toEqual(apiPlans);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('API Basic');
    expect(text).toContain('API Pro');
    expect(text).toContain('Απεριόριστα έγγραφα');
    expect(text).toContain('Συνιστώμενο');
    expect(text).toContain('Τρέχον');
  });

  it('marks the current tier from GET /api/subscriptions', () => {
    expect(billingStub.getSubscription).toHaveBeenCalled();
    expect(component.current?.tier).toBe('pro');
  });

  it('renders the "Διαχείριση συνδρομής" button and opens the portal', async () => {
    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>;
    const button = Array.from(buttons)
      .find((el) => el.textContent?.includes('Διαχείριση συνδρομής'));
    expect(button).toBeTruthy();

    // Resolving with '' keeps the test away from a real location navigation;
    // the service call is what this spec pins down.
    billingStub.createPortalSession.and.resolveTo('');

    await component.manageSubscription();

    expect(billingStub.createPortalSession).toHaveBeenCalled();
    expect(component.error).toBe('');
    expect(component.busy).toBe(false);
  });

  it('surfaces the mock-mode 403 from the portal button', async () => {
    billingStub.createPortalSession.and.rejectWith(
      new Error('Customer portal is only available in live Stripe mode')
    );

    await component.manageSubscription();

    // The server's English prose is logged, never rendered: the user sees
    // the translated copy for this channel.
    expect(component.error).toBe(lookupTranslation('el', 'billing.manageError')!);
    expect(component.error).not.toContain('live Stripe mode');
    expect(component.busy).toBe(false);
  });

  it('shows the reactivate button only when cancellation is scheduled', async () => {
    expect(component.canReactivate).toBe(false);
    expect(fixture.nativeElement.textContent).not.toContain('Επανενεργοποίηση συνδρομής');

    component.current = canceledState;
    fixture.detectChanges();

    expect(component.canReactivate).toBe(true);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Επανενεργοποίηση συνδρομής');
  });

  it('reactivate() calls the API, refreshes state and shows a notice', async () => {
    billingStub.getSubscription.calls.reset();
    billingStub.getSubscription.and.resolveTo(activeState);
    billingStub.reactivate.and.resolveTo({ id: 1, status: 'active' });
    component.current = canceledState;

    await component.reactivate();

    expect(billingStub.reactivate).toHaveBeenCalled();
    expect(billingStub.getSubscription).toHaveBeenCalled();
    expect(component.notice).toContain('επανενεργοποιήθηκε');
    expect(component.busy).toBe(false);
  });

  it('reactivate() surfaces server errors', async () => {
    billingStub.reactivate.and.rejectWith(
      new Error('Subscription has already ended and cannot be reactivated')
    );
    component.current = canceledState;

    await component.reactivate();

    // The server's English prose is logged, never rendered: the user sees
    // the translated copy for this channel.
    expect(component.error).toBe(lookupTranslation('el', 'billing.reactivateError')!);
    expect(component.error).not.toContain('already ended');
    expect(component.notice).toBe('');
    expect(component.busy).toBe(false);
  });

  it('upgrade() still uses createCheckoutSession (mock URL contract intact)', async () => {
    billingStub.createCheckoutSession.and.resolveTo('');

    await component.upgrade('enterprise');

    expect(billingStub.createCheckoutSession).toHaveBeenCalledWith('enterprise');
  });

  it('shows the cancelled notice and strips ?checkout from the URL', async () => {
    checkoutParam = 'cancelled';
    await init();

    expect(component.notice).toContain('ακυρώθηκε');
    expect(routerStub.navigate).toHaveBeenCalledWith(
      [],
      { queryParams: {}, replaceUrl: true }
    );
  });

  // ------------------------------------------------------------------
  // Error channels: the server's English prose is logged, never rendered.
  // ------------------------------------------------------------------

  it('shows the translated subscription-load copy — never the server prose', async () => {
    billingStub.getSubscription.and.rejectWith(
      new Error('Get subscription failed (HTTP 500)')
    );

    await component.ngOnInit();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'billing.loadSubscriptionError')!);
    expect(component.error).not.toContain('Get subscription failed');
    expect(fixture.nativeElement.textContent).not.toContain('Get subscription failed');
  });

  it('shows the translated plans-load copy — never the server prose', async () => {
    billingStub.getPlans.and.rejectWith(new Error('Plans failed (HTTP 500)'));

    await component.ngOnInit();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'billing.loadPlansError')!);
    expect(component.error).not.toContain('Plans failed');
    expect(fixture.nativeElement.textContent).not.toContain('Plans failed');
    expect(component.plansLoading).toBe(false);
  });

  it('shows the translated upgrade copy — never the server prose', async () => {
    billingStub.createCheckoutSession.and.rejectWith(
      new Error('Checkout failed (HTTP 500)')
    );

    await component.upgrade('pro');
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'billing.upgradeError')!);
    expect(component.error).not.toContain('Checkout failed');
    expect(fixture.nativeElement.textContent).not.toContain('Checkout failed');
    expect(component.busy).toBe(false);
  });
});
