import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ProfileComponent } from './profile.component';
import { AuthService, AuthUser } from '../../services/auth.service';
import { BillingService } from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';
import { QuotaService, QuotaUsage } from '../../services/quota.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

function usageStub(overrides: Partial<QuotaUsage> = {}): QuotaUsage {
  return {
    tier: 'basic',
    ai: { used: 3, limit: 20, resetAt: '2026-01-02T00:00:00.000Z' },
    documents: { used: 2, limit: 10 },
    ...overrides
  };
}

describe('ProfileComponent (today\'s quota usage)', () => {
  let fixture: ComponentFixture<ProfileComponent>;
  let component: ProfileComponent;
  let authStub: {
    userValue: AuthUser | null;
    exportData: jasmine.Spy;
    deleteAccount: jasmine.Spy;
  };
  let billingStub: { getSubscription: jasmine.Spy };
  let quotaStub: { getUsage: jasmine.Spy };
  let confirmStub: { ask: jasmine.Spy };

  beforeEach(async () => {
    authStub = {
      userValue: { id: 1, email: 'lawyer@example.com', role: 'user', subscription_tier: 'basic' },
      exportData: jasmine.createSpy('exportData').and.rejectWith(new Error('Access denied.')),
      deleteAccount: jasmine.createSpy('deleteAccount').and.rejectWith(new Error('Access denied.'))
    };
    billingStub = {
      getSubscription: jasmine.createSpy('getSubscription').and.resolveTo({
        subscription: null,
        tier: 'basic'
      })
    };
    quotaStub = {
      getUsage: jasmine.createSpy('getUsage').and.resolveTo(usageStub())
    };
    confirmStub = { ask: jasmine.createSpy('ask').and.resolveTo(true) };

    await TestBed.configureTestingModule({
      imports: [ProfileComponent],
      providers: [
        // 2-8: the profile template renders through the translate pipe and
        // the runtime copy is resolved via TranslateService.instant().
        ...provideTestTranslate(),
        { provide: AuthService, useValue: authStub },
        { provide: BillingService, useValue: billingStub },
        { provide: QuotaService, useValue: quotaStub },
        { provide: ConfirmService, useValue: confirmStub },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate').and.resolveTo(true) } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ProfileComponent);
    component = fixture.componentInstance;
  });

  it('renders today\'s AI and document usage', async () => {
    await component.ngOnInit();
    fixture.detectChanges();

    expect(quotaStub.getUsage).toHaveBeenCalled();
    expect(component.usage).not.toBeNull();
    expect(component.usage!.ai.used).toBe(3);
    expect(component.usage!.ai.limit).toBe(20);
    expect(component.usage!.documents.used).toBe(2);
    expect(component.usage!.documents.limit).toBe(10);

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(lookupTranslation('el', 'profile.usage')!);
    expect(text).toContain(lookupTranslation('el', 'profile.usageAi')!);
    expect(text).toContain(lookupTranslation('el', 'profile.usageDocuments')!);
    expect(text).toContain('3 / 20');
    expect(text).toContain('2 / 10');
  });

  it('renders a null limit as unlimited, never as 0 or null', async () => {
    quotaStub.getUsage.and.resolveTo(usageStub({
      tier: 'enterprise',
      ai: { used: 7, limit: null, resetAt: null },
      documents: { used: 12, limit: null }
    }));

    await component.ngOnInit();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain(lookupTranslation('el', 'profile.usageUnlimited')!);
    expect(text).not.toContain('0 / null');
    expect(text).not.toContain('null / ');
  });

  it('never claims "unlimited" for an absent limit — the number is unknown', async () => {
    quotaStub.getUsage.and.resolveTo(usageStub({
      tier: 'basic',
      ai: { used: 3, limit: undefined, resetAt: null },
      documents: { used: 2, limit: undefined }
    }));

    await component.ngOnInit();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(lookupTranslation('el', 'profile.usageUnlimited')!);
    // The unknown state is rendered as a dash, not as a number.
    expect(text).toContain('3 / —');
    expect(text).toContain('2 / —');
  });

  it('never claims "unlimited" for a malformed (non-numeric) limit', async () => {
    quotaStub.getUsage.and.resolveTo({
      tier: 'basic',
      ai: { used: 3, limit: 'twenty' as unknown as number, resetAt: null },
      documents: { used: 2, limit: 'ten' as unknown as number }
    });

    await component.ngOnInit();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain(lookupTranslation('el', 'profile.usageUnlimited')!);
    expect(text).not.toContain('twenty');
    expect(text).not.toContain('ten');
    expect(text).toContain('3 / —');
  });

  it('shows the usage load error without breaking the rest of the page', async () => {
    quotaStub.getUsage.and.rejectWith(new Error('usage endpoint down'));

    await component.ngOnInit();
    fixture.detectChanges();

    expect(component.usageError).toBe(lookupTranslation('el', 'profile.usageLoadError')!);
    expect(component.usage).toBeNull();
    // The rest of the profile still rendered.
    expect(component.state).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain(lookupTranslation('el', 'profile.gdpr')!);
  });

  it('keeps the profile error channel separate from the usage error channel', async () => {
    quotaStub.getUsage.and.rejectWith(new Error('usage endpoint down'));
    billingStub.getSubscription.and.rejectWith(new Error('subscription down'));

    await component.ngOnInit();
    fixture.detectChanges();

    // The billing backend's English prose is logged, never rendered.
    expect(component.error).toBe(lookupTranslation('el', 'profile.loadError')!);
    expect(component.error).not.toContain('subscription down');
    expect(component.usageError).toBe(lookupTranslation('el', 'profile.usageLoadError')!);
  });

  it('shows the translated export copy — never the server prose — for a failed export', async () => {
    await component.exportData();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'profile.exportError')!);
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
  });

  it('shows the translated delete copy — never the server prose — for a failed deletion', async () => {
    await component.deleteAccount();
    fixture.detectChanges();

    expect(component.error).toBe(lookupTranslation('el', 'profile.deleteError')!);
    expect(component.error).not.toContain('Access denied');
    expect(fixture.nativeElement.textContent).not.toContain('Access denied');
  });
});
