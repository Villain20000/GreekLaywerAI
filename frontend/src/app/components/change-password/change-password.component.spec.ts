import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { ChangePasswordComponent } from './change-password.component';
import { AuthService } from '../../services/auth.service';
import { Router, provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
import { MIN_PASSWORD_LENGTH } from '../../shared/auth.constants';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

/**
 * Greek copy for a dictionary key, with `{{param}}` placeholders resolved the
 * same way ngx-translate's default parser resolves them.
 *
 * The dictionary is the source of truth for the rendered wording, so the
 * assertions below resolve the key instead of hard-coding a literal. Throws
 * when the key is missing so a dictionary regression fails the spec loudly
 * instead of silently comparing against `undefined`.
 */
function elCopy(key: string, params: Record<string, string | number> = {}): string {
  const raw = lookupTranslation('el', key);
  if (raw === undefined) {
    throw new Error(`Missing i18n key: ${key}`);
  }
  return Object.entries(params).reduce(
    (text, [name, value]) =>
      text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), String(value)),
    raw
  );
}

describe('ChangePasswordComponent', () => {
  let component: ChangePasswordComponent;
  let fixture: ComponentFixture<ChangePasswordComponent>;
  let mockAuthService: { changePassword: jasmine.Spy };
  let mockRouter: Router;

  beforeEach(async () => {
    mockAuthService = {
      changePassword: jasmine
        .createSpy('changePassword')
        .and.resolveTo({ ok: true })
    };

    await TestBed.configureTestingModule({
      imports: [ChangePasswordComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        // Real Router via provideRouter + spy on navigate: RouterLink needs a
        // working ActivatedRoute/Router graph to render hrefs, while the specs
        // only care about programmatic navigate() calls.
        provideRouter([]),
        // 2-8 (i18n): the form template uses the `translate` pipe and the
        // component injects TranslateService, so the spec needs the
        // ngx-translate providers (TranslateStore is not `providedIn: 'root'`
        // in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    mockRouter = TestBed.inject(Router);
    spyOn(mockRouter, 'navigate');

    fixture = TestBed.createComponent(ChangePasswordComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should reject empty fields', async () => {
    component.currentPassword = '';
    component.newPassword = '';
    component.confirmPassword = '';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(mockAuthService.changePassword).not.toHaveBeenCalled();
  });

  it('should reject new passwords shorter than MIN_PASSWORD_LENGTH', async () => {
    component.currentPassword = 'oldPassword123';
    component.newPassword = 'short';
    component.confirmPassword = 'short';
    await component.onSubmit();
    expect(component.error).toBe(
      elCopy('common.passwordMin', { min: MIN_PASSWORD_LENGTH })
    );
    expect(mockAuthService.changePassword).not.toHaveBeenCalled();
  });

  it('should reject mismatched confirmation', async () => {
    component.currentPassword = 'oldPassword123';
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword789';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('auth.change.mismatch'));
    expect(mockAuthService.changePassword).not.toHaveBeenCalled();
  });

  it('should reject new password identical to current', async () => {
    component.currentPassword = 'samePassword1';
    component.newPassword = 'samePassword1';
    component.confirmPassword = 'samePassword1';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('auth.change.sameAsCurrent'));
    expect(mockAuthService.changePassword).not.toHaveBeenCalled();
  });

  it('should call changePassword and clear the form on success', fakeAsync(() => {
    component.currentPassword = 'oldPassword123';
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';
    component.onSubmit();
    tick();

    expect(mockAuthService.changePassword).toHaveBeenCalledWith(
      'oldPassword123',
      'newPassword456'
    );
    expect(component.success).toBeTrue();
    expect(component.isLoading).toBeFalse();
    expect(component.currentPassword).toBe('');
    expect(component.newPassword).toBe('');
    expect(component.confirmPassword).toBe('');
  }));

  it('should surface server error and stop loading on failure', fakeAsync(() => {
    mockAuthService.changePassword.and.resolveTo({
      ok: false,
      kind: 'password_change_failed',
      code: 'password_change_failed',
      error: 'Password change failed',
      status: 400
    });

    component.currentPassword = 'oldPassword123';
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';
    component.onSubmit();
    tick();

    // The rendered copy is the TRANSLATED one picked by the backend's
    // `code` — the raw English server prose never reaches the user.
    expect(component.error).toBe(elCopy('auth.errors.passwordChangeFailed'));
    expect(component.error).not.toContain('Password change failed');
    expect(component.success).toBeFalse();
    expect(component.isLoading).toBeFalse();
  }));

  // ── DOM-driven affordance tests (polish parity with LoginComponent) ───

  it('renders the brand-row wordmark', () => {
    const brandRow = fixture.debugElement.query(By.css('.brand-row'));
    expect(brandRow).not.toBeNull();
    expect(brandRow.nativeElement.textContent).toContain('NomosAI');
  });

  it('renders the auth-links footer with a single Back-to-workspace routerLink', () => {
    const links = fixture.debugElement.queryAll(By.css('.auth-links a.auth-link'));
    expect(links.length).toBe(1);
    expect(links[0].nativeElement.getAttribute('href')).toBe('/chat');
    expect(links[0].nativeElement.textContent).toContain(
      elCopy('auth.change.backToWorkspace')
    );
  });

  it('starts with all three password peek toggles hidden', () => {
    expect(component.showCurrent).toBeFalse();
    expect(component.showNew).toBeFalse();
    expect(component.showConfirm).toBeFalse();
  });

  it('peek-btn clicks independently toggle each of the three rows', () => {
    const peekBtns = fixture.debugElement.queryAll(By.css('.peek-btn'));
    expect(peekBtns.length).toBe(3);

    peekBtns[0].nativeElement.click();
    expect(component.showCurrent).toBeTrue();

    peekBtns[1].nativeElement.click();
    expect(component.showNew).toBeTrue();

    peekBtns[2].nativeElement.click();
    expect(component.showConfirm).toBeTrue();

    peekBtns[1].nativeElement.click();
    expect(component.showNew).toBeFalse(); // other toggles unchanged
    expect(component.showCurrent).toBeTrue();
    expect(component.showConfirm).toBeTrue();
  });

  it('updates the password input #type in lockstep with each show toggle', () => {
    const inputs = ['#current-password', '#new-password', '#confirm-new-password'];
    const refs = inputs.map((s) => fixture.debugElement.query(By.css(s)));
    expect(refs.every((r) => r.nativeElement.getAttribute('type') === 'password')).toBeTrue();

    component.toggleCurrent();
    fixture.detectChanges();
    expect(refs[0].nativeElement.getAttribute('type')).toBe('text');
    expect(refs[1].nativeElement.getAttribute('type')).toBe('password');

    component.toggleNew();
    fixture.detectChanges();
    expect(refs[1].nativeElement.getAttribute('type')).toBe('text');

    component.toggleConfirm();
    fixture.detectChanges();
    expect(refs[2].nativeElement.getAttribute('type')).toBe('text');
  });

  it('dispatches a synthetic Enter on confirm-password → onSubmit fires', fakeAsync(() => {
    component.currentPassword = 'oldPassword123';
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';

    const input = fixture.debugElement.query(By.css('#confirm-new-password'));
    input.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    expect(mockAuthService.changePassword).toHaveBeenCalledWith(
      'oldPassword123',
      'newPassword456'
    );
    expect(component.success).toBeTrue();
  }));
});
