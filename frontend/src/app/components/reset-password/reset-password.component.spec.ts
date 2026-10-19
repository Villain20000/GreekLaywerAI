import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { ResetPasswordComponent } from './reset-password.component';
import { AuthService, TokenAuthResult } from '../../services/auth.service';
import { MIN_PASSWORD_LENGTH } from '../../shared/auth.constants';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

const VALID_TOKEN = 'a'.repeat(64);

/**
 * Greek copy for a dictionary key, with `{{param}}` placeholders resolved
 * the same way ngx-translate's default parser resolves them.
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

/**
 * /reset-password consumes the one-time token from `?token=…` and posts the
 * new password. The server answers `invalid_token` for every flavour of
 * bad token; the component must show the TRANSLATED copy of that code, not
 * the raw English server prose.
 */
describe('ResetPasswordComponent', () => {
  let component: ResetPasswordComponent;
  let fixture: ComponentFixture<ResetPasswordComponent>;
  let mockAuthService: { resetPassword: jasmine.Spy };
  let mockRouter: Router;
  let queryParams: Record<string, string>;

  beforeEach(async () => {
    queryParams = { token: VALID_TOKEN };
    mockAuthService = {
      resetPassword: jasmine
        .createSpy<(token: string, newPassword: string) => Promise<TokenAuthResult>>(
          'resetPassword'
        )
        .and.returnValue(
          Promise.resolve({
            ok: true,
            token: 'jwt-abc',
            user: { id: 1, email: 'user@nomos.ai', role: 'user', subscription_tier: 'basic' }
          })
        )
    };

    await TestBed.configureTestingModule({
      imports: [ResetPasswordComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        // provideRouter() provides an ActivatedRoute of its own, so it has
        // to come FIRST — the stub below has to win.
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              get queryParamMap() {
                return convertToParamMap(queryParams);
              }
            }
          }
        },
        // The template uses the `translate` pipe → the ngx-translate
        // providers are mandatory (TranslateStore is not
        // `providedIn: 'root'` in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    mockRouter = TestBed.inject(Router);
    spyOn(mockRouter, 'navigate');

    fixture = TestBed.createComponent(ResetPasswordComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('reads the reset token from the query string', () => {
    expect(component.token).toBe(VALID_TOKEN);
  });

  it('shows the "missing token" notice when the URL carries no token', () => {
    queryParams = {};
    const fresh = TestBed.createComponent(ResetPasswordComponent);
    fresh.detectChanges();

    expect(fresh.componentInstance.token).toBeNull();
    const notice = fresh.debugElement.query(By.css('.error-msg'));
    expect(notice.nativeElement.textContent).toContain(
      elCopy('auth.reset.missingToken')
    );
  });

  it('rejects empty fields before calling the server', async () => {
    component.newPassword = '';
    component.confirmPassword = '';

    await component.onSubmit();

    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(mockAuthService.resetPassword).not.toHaveBeenCalled();
  });

  it('rejects a password below the minimum length', async () => {
    component.newPassword = 'short';
    component.confirmPassword = 'short';

    await component.onSubmit();

    expect(component.error).toBe(
      elCopy('common.passwordMin', { min: MIN_PASSWORD_LENGTH })
    );
    expect(mockAuthService.resetPassword).not.toHaveBeenCalled();
  });

  it('rejects a mismatched confirmation', async () => {
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword789';

    await component.onSubmit();

    expect(component.error).toBe(elCopy('common.passwordsMismatch'));
    expect(mockAuthService.resetPassword).not.toHaveBeenCalled();
  });

  it('resets the password, clears the form and navigates to /chat', fakeAsync(() => {
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';

    component.onSubmit();
    tick();

    expect(mockAuthService.resetPassword).toHaveBeenCalledWith(
      VALID_TOKEN,
      'newPassword456'
    );
    expect(component.success).toBeTrue();
    expect(component.isLoading).toBeFalse();
    expect(component.newPassword).toBe('');
    expect(component.confirmPassword).toBe('');

    tick(600);
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/chat']);
  }));

  it('shows the translated copy for code=invalid_token, never the raw English prose', fakeAsync(() => {
    mockAuthService.resetPassword.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_token',
        code: 'invalid_token',
        error: 'Invalid or expired reset link',
        status: 400
      })
    );
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';

    component.onSubmit();
    tick();
    fixture.detectChanges();

    expect(component.error).toBe(elCopy('auth.errors.invalidToken'));
    expect(component.error).not.toContain('Invalid or expired reset link');
    expect(component.success).toBeFalse();

    const banner = fixture.debugElement.query(By.css('.error-msg'));
    expect(banner.nativeElement.textContent).toContain(
      elCopy('auth.errors.invalidToken')
    );

    tick(600);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  it('refuses to submit without a token', async () => {
    component.token = null;
    component.newPassword = 'newPassword456';
    component.confirmPassword = 'newPassword456';

    await component.onSubmit();

    expect(component.error).toBe(
      elCopy('auth.reset.missingTokenError')
    );
    expect(mockAuthService.resetPassword).not.toHaveBeenCalled();
  });
});
