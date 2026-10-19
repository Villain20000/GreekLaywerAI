import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { ForgotPasswordComponent } from './forgot-password.component';
import { AuthService, SimpleAuthResult } from '../../services/auth.service';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';
/**
 * Greek copy for a dictionary key. Throws when the key is missing so a
 * dictionary regression fails the spec loudly instead of silently
 * comparing against `undefined`.
 */
function elCopy(key: string): string {
  const raw = lookupTranslation('el', key);
  if (raw === undefined) {
    throw new Error(`Missing i18n key: ${key}`);
  }
  return raw;
}


/**
 * /forgot-password is anti-enumeration by design: the server answers 200
 * for known AND unknown addresses, and the component always shows the same
 * generic message. The specs pin that behaviour — the server's failure
 * copy must never leak into the UI.
 */
describe('ForgotPasswordComponent', () => {
  let component: ForgotPasswordComponent;
  let fixture: ComponentFixture<ForgotPasswordComponent>;
  let mockAuthService: { forgotPassword: jasmine.Spy };

  beforeEach(async () => {
    mockAuthService = {
      forgotPassword: jasmine
        .createSpy<(email: string) => Promise<SimpleAuthResult>>('forgotPassword')
        .and.returnValue(Promise.resolve({ ok: true }))
    };

    await TestBed.configureTestingModule({
      imports: [ForgotPasswordComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        provideRouter([]),
        // The template uses the `translate` pipe → the ngx-translate
        // providers are mandatory (TranslateStore is not
        // `providedIn: 'root'` in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ForgotPasswordComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('rejects an empty email before calling the server', async () => {
    component.email = '';

    await component.onSubmit();

    expect(component.error).toBe(elCopy('common.enterEmail'));
    expect(mockAuthService.forgotPassword).not.toHaveBeenCalled();
    expect(component.submitted).toBeFalse();
  });

  it('rejects a malformed email before calling the server', async () => {
    component.email = 'not-an-email';

    await component.onSubmit();

    expect(component.error).toBe(elCopy('common.invalidEmail'));
    expect(mockAuthService.forgotPassword).not.toHaveBeenCalled();
  });

  it('requests the reset mail and shows the generic confirmation', fakeAsync(() => {
    component.email = 'user@nomos.ai';

    component.onSubmit();
    tick();
    fixture.detectChanges();

    expect(mockAuthService.forgotPassword).toHaveBeenCalledWith('user@nomos.ai');
    expect(component.submitted).toBeTrue();
    expect(component.isLoading).toBeFalse();
    expect(component.error).toBe('');

    const success = fixture.debugElement.query(By.css('.success-msg'));
    expect(success).not.toBeNull();
    expect(success.nativeElement.textContent).toContain(
      elCopy('auth.forgot.success')
    );
  }));

  it('shows the same generic confirmation when the server fails (no enumeration oracle)', fakeAsync(() => {
    mockAuthService.forgotPassword.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'server',
        code: 'server_error',
        error: 'Server error',
        status: 500
      })
    );
    component.email = 'user@nomos.ai';

    component.onSubmit();
    tick();
    fixture.detectChanges();

    // The failure copy is swallowed: the user must not learn anything
    // about the address from the wording.
    expect(component.submitted).toBeTrue();
    expect(component.error).toBe('');
    const success = fixture.debugElement.query(By.css('.success-msg'));
    expect(success.nativeElement.textContent).toContain(
      elCopy('auth.forgot.success')
    );
  }));

  it('clears a previous error when a new submission starts', fakeAsync(() => {
    component.email = 'nope';
    component.onSubmit();
    tick();
    expect(component.error).toBe(elCopy('common.invalidEmail'));

    component.email = 'user@nomos.ai';
    component.onSubmit();
    tick();

    expect(component.error).toBe('');
    expect(component.submitted).toBeTrue();
  }));

  it('links back to the sign-in page', () => {
    const link = fixture.debugElement.query(By.css('.footer-link a'));

    expect(link).not.toBeNull();
    expect(link.nativeElement.getAttribute('href')).toBe('/login');
  });
});
