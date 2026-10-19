import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AdminComponent } from './admin.component';
import { AdminService, AdminUser } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { provideTestTranslate, lookupTranslation } from '../../i18n/testing';
import { of, throwError } from 'rxjs';

describe('AdminComponent', () => {
  let fixture: ComponentFixture<AdminComponent>;
  let component: AdminComponent;
  let adminStub: jasmine.SpyObj<AdminService>;
  let authStub: { userValue: AdminUser | null; logout: jasmine.Spy; consumeMagicLinkBannerFlag: jasmine.Spy };
  let routerStub: { navigate: jasmine.Spy };

  const adminUser: AdminUser = {
    id: 99,
    email: 'admin@nomos.ai',
    role: 'admin',
    subscription_tier: 'enterprise',
    created_at: '2025-01-01'
  };
  const lawyerUser: AdminUser = {
    id: 2,
    email: 'lawyer@nomos.ai',
    role: 'user',
    subscription_tier: 'basic',
    created_at: '2025-01-02'
  };

  beforeEach(async () => {
    adminStub = jasmine.createSpyObj<AdminService>('AdminService', [
      'listUsers',
      'listAuditLog',
      'getFeedbackSummary',
      'updateRole',
      'updateTier'
    ]);

    authStub = {
      userValue: adminUser,
      logout: jasmine.createSpy('logout'),
      // Phase 25 (admin bypass): default false so legacy tests stay
      // banner-free. The banner tests below override this per-case.
      consumeMagicLinkBannerFlag: jasmine
        .createSpy('consumeMagicLinkBannerFlag')
        .and.returnValue(false)
    };

    routerStub = { navigate: jasmine.createSpy('navigate') };

    adminStub.getFeedbackSummary.and.returnValue(of({
      days: 30, total: 10, helpful: 8, unhelpful: 2, helpfulRate: 0.8, lastSubmittedAt: null
    }));

    adminStub.listUsers.and.returnValue(
      of({ users: [adminUser, lawyerUser], total: 2, limit: 25, offset: 0 })
    );

    adminStub.listAuditLog.and.returnValue(
      of({
        auditLog: [
          {
            id: 1,
            user_id: 2,
            action: 'admin.role_changed',
            resource_type: 'user',
            resource_id: '2',
            old_value: { role: 'user' },
            new_value: { role: 'enterprise' },
            ip_address: '127.0.0.1',
            created_at: '2026-01-01T00:00:00Z'
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      })
    );

    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: AdminService, useValue: adminStub },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub },
        ...provideTestTranslate()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should load and render users on init', () => {
    expect(adminStub.listUsers).toHaveBeenCalledWith({ q: undefined, limit: 25, offset: 0 });
    expect(component.users.length).toBe(2);
    expect(component.users[0].email).toBe('admin@nomos.ai');
    expect(component.userTotal).toBe(2);
  });

  it('should load the audit log on init', () => {
    expect(adminStub.listAuditLog).toHaveBeenCalledWith({ userId: undefined, action: undefined, limit: 50, offset: 0 });
    expect(component.auditLog.length).toBe(1);
    expect(component.auditLog[0].action).toBe('admin.role_changed');
    expect(component.auditTotal).toBe(1);
  });

  it('isSelf() returns true only for the signed-in admin row', () => {
    expect(component.isSelf({ ...adminUser, role: 'user' })).toBe(true);
    expect(component.isSelf(lawyerUser)).toBe(false);
  });

  it('changeRole() applies an optimistic update and persists on success', fakeAsync(() => {
    const target = { ...lawyerUser };
    adminStub.updateRole.and.returnValue(
      of({ ...lawyerUser, role: 'enterprise', subscription_tier: 'enterprise' })
    );

    component.changeRole(target, 'enterprise');
    tick();

    expect(adminStub.updateRole).toHaveBeenCalledWith(2, 'enterprise');
    const updated = component.users.find((u) => u.id === 2);
    expect(updated?.role).toBe('enterprise');
    expect(component.saving[2]).toBe(false);
  }));

  it('changeRole() reverts the optimistic update on error', fakeAsync(() => {
    const target = { ...lawyerUser };
    component.saving = {}; // reset
    adminStub.updateRole.and.returnValue(throwError(() => new Error('Forbidden')));

    component.changeRole(target, 'enterprise');
    tick();

    const reverted = component.users.find((u) => u.id === 2);
    expect(reverted?.role).toBe('user');
    expect(component.errorMessage).toContain('Forbidden');
  }));

  it('changeTier() applies an optimistic update for tier changes', fakeAsync(() => {
    const target = { ...lawyerUser };
    adminStub.updateTier.and.returnValue(
      of({ ...lawyerUser, subscription_tier: 'enterprise' })
    );

    component.changeTier(target, 'enterprise');
    tick();

    expect(adminStub.updateTier).toHaveBeenCalledWith(2, 'enterprise');
    const updated = component.users.find((u) => u.id === 2);
    expect(updated?.subscription_tier).toBe('enterprise');
  }));

  it('refuses self-demotion in the UI', () => {
    component.changeRole({ ...adminUser }, 'user');
    expect(adminStub.updateRole).not.toHaveBeenCalled();
    expect(component.errorMessage).toContain(
      lookupTranslation('el', 'admin.selfDemoteError')
    );
  });

  it('logout() delegates to AuthService.logout', () => {
    component.logout();
    expect(authStub.logout).toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 2-4: users search + pagination.
  // ------------------------------------------------------------------

  it('applyUserSearch() sends q and resets offset to zero', () => {
    adminStub.listUsers.calls.reset();
    component.userQuery = '  lawyer@nomos.ai ';
    component.userOffset = 75;

    component.applyUserSearch();

    expect(adminStub.listUsers).toHaveBeenCalledWith({
      q: 'lawyer@nomos.ai',
      limit: 25,
      offset: 0
    });
  });

  it('clearUserSearch() clears the query and reloads from the first page', () => {
    adminStub.listUsers.calls.reset();
    component.userQuery = 'lawyer';
    component.userOffset = 50;

    component.clearUserSearch();

    expect(component.userQuery).toBe('');
    expect(adminStub.listUsers).toHaveBeenCalledWith({ q: undefined, limit: 25, offset: 0 });
  });

  it('nextUserPage() advances by the page size and prevUserPage() goes back', () => {
    adminStub.listUsers.calls.reset();
    component.userTotal = 60;
    component.userLimit = 25;
    component.userOffset = 0;

    component.nextUserPage();
    expect(component.userOffset).toBe(25);
    expect(adminStub.listUsers).toHaveBeenCalledWith({ q: undefined, limit: 25, offset: 25 });

    component.prevUserPage();
    expect(component.userOffset).toBe(0);
  });

  it('nextUserPage() is a no-op on the last page', () => {
    adminStub.listUsers.calls.reset();
    component.userTotal = 10;
    component.userLimit = 25;
    component.userOffset = 0;

    component.nextUserPage();

    expect(adminStub.listUsers).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 2-4: feedback window selector.
  // ------------------------------------------------------------------

  it('onFeedbackDaysChange() reloads the summary for the selected window', () => {
    adminStub.getFeedbackSummary.calls.reset();

    component.onFeedbackDaysChange(90);

    expect(component.feedbackDays).toBe(90);
    expect(adminStub.getFeedbackSummary).toHaveBeenCalledWith(90);
  });

  it('ignores an invalid feedback window', () => {
    adminStub.getFeedbackSummary.calls.reset();

    component.onFeedbackDaysChange('nope');

    expect(component.feedbackDays).toBe(30);
    expect(adminStub.getFeedbackSummary).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // 2-4: audit-log viewer filters + pagination.
  // ------------------------------------------------------------------

  it('applyAuditFilters() forwards action/userId and resets paging', () => {
    adminStub.listAuditLog.calls.reset();
    component.auditAction = 'admin.tier_changed';
    component.auditUserId = 2;
    component.auditOffset = 100;

    component.applyAuditFilters();

    expect(adminStub.listAuditLog).toHaveBeenCalledWith({
      userId: 2,
      action: 'admin.tier_changed',
      limit: 50,
      offset: 0
    });
  });

  it('clearAuditFilters() resets filters and reloads', () => {
    adminStub.listAuditLog.calls.reset();
    component.auditAction = 'admin.tier_changed';
    component.auditUserId = 2;

    component.clearAuditFilters();

    expect(component.auditAction).toBe('');
    expect(component.auditUserId).toBeNull();
    expect(adminStub.listAuditLog).toHaveBeenCalledWith({
      userId: undefined,
      action: undefined,
      limit: 50,
      offset: 0
    });
  });

  it('nextAuditPage() advances by the audit page size', () => {
    adminStub.listAuditLog.calls.reset();
    component.auditTotal = 120;
    component.auditLimit = 50;
    component.auditOffset = 0;

    component.nextAuditPage();

    expect(component.auditOffset).toBe(50);
    expect(adminStub.listAuditLog).toHaveBeenCalledWith(
      jasmine.objectContaining({ limit: 50, offset: 50 })
    );
  });

  it('formatAuditValue() renders object changes as compact JSON', () => {
    expect(component.formatAuditValue(null)).toBe('—');
    expect(component.formatAuditValue({ role: 'pro' })).toBe('{"role":"pro"}');
  });

  it('openAdminDocuments() navigates to the admin documents route', () => {
    component.openAdminDocuments();
    expect(routerStub.navigate).toHaveBeenCalledWith(['/admin/documents']);
  });

  // ------------------------------------------------------------------
  // Phase 25 (admin bypass): "Signed in via magic link" banner behavior.
  // The sessionStorage flag itself is exercised by AuthService tests;
  // here we pin the AdminComponent side of the wiring — show-on-
  // consume, auto-hide at 30s, and manual dismiss cancelling the timer.
  // ------------------------------------------------------------------

  it('shows the magic-link banner + auto-hides after 30s', fakeAsync(() => {
    authStub.consumeMagicLinkBannerFlag.and.returnValue(true);
    component.ngOnInit();
    expect(component.bannerVisible).toBe(true);
    expect(authStub.consumeMagicLinkBannerFlag).toHaveBeenCalled();
    // Wallclock advance past the 30s auto-hide threshold.
    tick(30_001);
    expect(component.bannerVisible).toBe(false);
  }));

  it('does NOT show the magic-link banner when consumeMagicLinkBannerFlag returns false', () => {
    authStub.consumeMagicLinkBannerFlag.and.returnValue(false);
    component.ngOnInit();
    expect(component.bannerVisible).toBe(false);
  });

  it('dismissMagicLinkBanner() hides immediately and prevents the 30s timer from re-firing', fakeAsync(() => {
    authStub.consumeMagicLinkBannerFlag.and.returnValue(true);
    component.ngOnInit();
    expect(component.bannerVisible).toBe(true);
    component.dismissMagicLinkBanner();
    expect(component.bannerVisible).toBe(false);
    // Wallclock advance past the 30s threshold — dismissed timer must
    // not have re-fired (or never fired) into a re-show.
    tick(30_001);
    expect(component.bannerVisible).toBe(false);
  }));
});
