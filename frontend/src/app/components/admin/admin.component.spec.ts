import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { AdminComponent } from './admin.component';
import { AdminService, AdminUser } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('AdminComponent', () => {
  let fixture: ComponentFixture<AdminComponent>;
  let component: AdminComponent;
  let adminStub: jasmine.SpyObj<AdminService>;
  let authStub: { userValue: AdminUser | null; logout: jasmine.Spy; consumeMagicLinkBannerFlag: jasmine.Spy };
  let routerStub: { navigate: jasmine.Spy };

  beforeEach(async () => {
    adminStub = jasmine.createSpyObj<AdminService>('AdminService', [
      'listUsers',
      'updateRole',
      'updateTier'
    ]);

    authStub = {
      userValue: {
        id: 99,
        email: 'admin@nomos.ai',
        role: 'admin',
        subscription_tier: 'enterprise',
        created_at: '2025-01-01'
      },
      logout: jasmine.createSpy('logout'),
      // Phase 25 (admin bypass): default false so legacy tests stay
      // banner-free. The banner tests below override this per-case.
      consumeMagicLinkBannerFlag: jasmine
        .createSpy('consumeMagicLinkBannerFlag')
        .and.returnValue(false)
    };

    routerStub = { navigate: jasmine.createSpy('navigate') };

    adminStub.listUsers.and.returnValue(
      of([
        { id: 99, email: 'admin@nomos.ai', role: 'admin', subscription_tier: 'enterprise', created_at: '2025-01-01' },
        { id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' }
      ])
    );

    await TestBed.configureTestingModule({
      imports: [AdminComponent],
      providers: [
        { provide: AdminService, useValue: adminStub },
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AdminComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should load and render users on init', () => {
    expect(adminStub.listUsers).toHaveBeenCalled();
    expect(component.users.length).toBe(2);
    expect(component.users[0].email).toBe('admin@nomos.ai');
  });

  it('isSelf() returns true only for the signed-in admin row', () => {
    expect(component.isSelf({ id: 99, email: 'x', role: 'user', subscription_tier: 'basic', created_at: '' })).toBe(true);
    expect(component.isSelf({ id: 2, email: 'x', role: 'user', subscription_tier: 'basic', created_at: '' })).toBe(false);
  });

  it('changeRole() applies an optimistic update and persists on success', fakeAsync(() => {
    const target = { id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' } as AdminUser;
    adminStub.updateRole.and.returnValue(
      of({ id: 2, email: 'lawyer@nomos.ai', role: 'enterprise', subscription_tier: 'enterprise', created_at: '2025-01-02' })
    );

    component.changeRole(target, 'enterprise');
    tick();

    expect(adminStub.updateRole).toHaveBeenCalledWith(2, 'enterprise');
    const updated = component.users.find((u) => u.id === 2);
    expect(updated?.role).toBe('enterprise');
    expect(component.saving[2]).toBe(false);
  }));

  it('changeRole() reverts the optimistic update on error', fakeAsync(() => {
    const target = { id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' } as AdminUser;
    component.saving = {}; // reset
    adminStub.updateRole.and.returnValue(throwError(() => new Error('Forbidden')));

    component.changeRole(target, 'enterprise');
    tick();

    const reverted = component.users.find((u) => u.id === 2);
    expect(reverted?.role).toBe('user');
    expect(component.errorMessage).toContain('Forbidden');
  }));

  it('changeTier() applies an optimistic update for tier changes', fakeAsync(() => {
    const target = { id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' } as AdminUser;
    adminStub.updateTier.and.returnValue(
      of({ id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'enterprise', created_at: '2025-01-02' })
    );

    component.changeTier(target, 'enterprise');
    tick();

    expect(adminStub.updateTier).toHaveBeenCalledWith(2, 'enterprise');
    const updated = component.users.find((u) => u.id === 2);
    expect(updated?.subscription_tier).toBe('enterprise');
  }));

  it('refuses self-demotion in the UI', () => {
    const self = { id: 99, email: 'admin@nomos.ai', role: 'admin', subscription_tier: 'enterprise', created_at: '2025-01-01' } as AdminUser;
    component.changeRole(self, 'user');
    expect(adminStub.updateRole).not.toHaveBeenCalled();
    expect(component.errorMessage).toContain('demote');
  });

  it('logout() delegates to AuthService.logout', () => {
    component.logout();
    expect(authStub.logout).toHaveBeenCalled();
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
