import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { RegisterComponent } from './register.component';
import { AuthService } from '../../services/auth.service';
import { Router, provideRouter } from '@angular/router';
import { By } from '@angular/platform-browser';
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

describe('RegisterComponent', () => {
  let component: RegisterComponent;
  let fixture: ComponentFixture<RegisterComponent>;
  let mockAuthService: { register: jasmine.Spy; resendVerification: jasmine.Spy };
  let mockRouter: Router;

  beforeEach(async () => {
    mockAuthService = {
      register: jasmine.createSpy('register').and.resolveTo({ ok: true }),
      resendVerification: jasmine
        .createSpy('resendVerification')
        .and.resolveTo({ ok: true })
    };

    await TestBed.configureTestingModule({
      imports: [RegisterComponent],
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

    fixture = TestBed.createComponent(RegisterComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should reject empty fields', async () => {
    component.email = '';
    component.password = '';
    component.confirmPassword = '';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeFalse();
    expect(mockAuthService.register).not.toHaveBeenCalled();
  });

  it('should reject malformed email addresses', async () => {
    component.email = 'not-an-email';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('common.invalidEmail'));
    expect(mockAuthService.register).not.toHaveBeenCalled();
  });

  it('should reject passwords shorter than 8 chars', async () => {
    component.email = 'test@nomos.ai';
    component.password = 'short';
    component.confirmPassword = 'short';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('common.passwordMin', { min: 8 }));
  });

  it('should reject mismatched confirmation', async () => {
    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password456';
    await component.onSubmit();
    expect(component.error).toBe(elCopy('common.passwordsMismatch'));
  });

  it('should reveal the verify-panel after a successful register', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: true,
      requires_verification: true,
      user: { email: 'test@nomos.ai' }
    });

    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();
    fixture.detectChanges();

    expect(component.submitted).toBeTrue();
    expect(component.submittedEmail).toBe('test@nomos.ai');
    expect(mockRouter.navigate).not.toHaveBeenCalled();

    const verifyPanel = fixture.debugElement.query(By.css('.verify-panel'));
    expect(verifyPanel).not.toBeNull();
    expect(verifyPanel.nativeElement.textContent).toContain(elCopy('auth.register.checkEmail'));
    expect(verifyPanel.nativeElement.textContent).toContain('test@nomos.ai');
  }));

  it('should surface server error and stop loading on failure', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: false,
      kind: 'email_taken',
      code: 'email_taken',
      error: 'User already exists',
      status: 400
    });

    component.email = 'taken@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();

    // The rendered copy is the TRANSLATED one picked by the backend's
    // `code` — the raw English server prose never reaches the user.
    expect(component.error).toBe(elCopy('auth.errors.emailTaken'));
    expect(component.error).not.toContain('User already exists');
    expect(component.isLoading).toBeFalse();
    expect(component.submitted).toBeFalse();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  // ── DOM-driven affordance tests (polish parity with LoginComponent) ───

  it('renders the brand-row wordmark on the create-account form', () => {
    const brand = fixture.debugElement.query(By.css('.brand-row'));
    expect(brand).not.toBeNull();
    expect(brand.nativeElement.textContent).toContain('NomosAI');
  });

  it('renders the auth-links footer routing back to /login', () => {
    const links = fixture.debugElement.queryAll(By.css('.auth-links a.auth-link'));
    expect(links.length).toBe(1);
    expect(links[0].nativeElement.getAttribute('href')).toBe('/login');
    expect(links[0].nativeElement.textContent).toContain(elCopy('auth.register.haveAccount'));
  });

  it('starts with both password peek toggles hidden', () => {
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeFalse();
  });

  it('peek-btn clicks toggle showPassword and showConfirmPassword independently', () => {
    const peekBtns = fixture.debugElement.queryAll(By.css('.peek-btn'));
    expect(peekBtns.length).toBe(2);

    peekBtns[0].nativeElement.click();
    expect(component.showPassword).toBeTrue();
    expect(component.showConfirmPassword).toBeFalse();

    peekBtns[1].nativeElement.click();
    expect(component.showConfirmPassword).toBeTrue();

    peekBtns[0].nativeElement.click();
    expect(component.showPassword).toBeFalse();
    expect(component.showConfirmPassword).toBeTrue();
  });

  it('updates password input type in lockstep with showPassword', () => {
    component.togglePasswordVisibility();
    fixture.detectChanges();
    const pwInput = fixture.debugElement.query(By.css('#register-password'));
    expect(pwInput.nativeElement.getAttribute('type')).toBe('text');

    component.togglePasswordVisibility();
    fixture.detectChanges();
    expect(pwInput.nativeElement.getAttribute('type')).toBe('password');
  });

  it('updates confirm-password input type in lockstep with showConfirmPassword', () => {
    component.toggleConfirmPasswordVisibility();
    fixture.detectChanges();
    const confirm = fixture.debugElement.query(By.css('#register-confirm-password'));
    expect(confirm.nativeElement.getAttribute('type')).toBe('text');

    component.toggleConfirmPasswordVisibility();
    fixture.detectChanges();
    expect(confirm.nativeElement.getAttribute('type')).toBe('password');
  });

  it('dispatches a synthetic Enter on email field → onSubmit fires', fakeAsync(() => {
    component.email = 'a@b.com';
    component.password = '';
    component.confirmPassword = '';

    const emailInput = fixture.debugElement.query(By.css('#register-email'));
    emailInput.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    // Empty fields short-circuit → no AuthService.register call,
    // error reads the translated "fill in all fields" copy.
    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(mockAuthService.register).not.toHaveBeenCalled();
  }));

  it('dispatches a synthetic Enter on password field → onSubmit fires', fakeAsync(() => {
    component.email = 'a@b.com';
    component.password = 'a@b.com';
    component.confirmPassword = '';

    const pwInput = fixture.debugElement.query(By.css('#register-password'));
    pwInput.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(mockAuthService.register).not.toHaveBeenCalled();
  }));

  it('verify-panel renders the resend CTA calling authService.resendVerification', fakeAsync(() => {
    mockAuthService.register.and.resolveTo({
      ok: true,
      requires_verification: true,
      user: { email: 'test@nomos.ai' }
    });
    component.email = 'test@nomos.ai';
    component.password = 'password123';
    component.confirmPassword = 'password123';
    component.onSubmit();
    tick();
    fixture.detectChanges();

    const verifyPanel = fixture.debugElement.query(By.css('.verify-panel'));
    const resendBtn = verifyPanel.query(By.css('button.secondary'));
    expect(resendBtn).not.toBeNull();
    resendBtn.nativeElement.click();
    tick();

    expect(mockAuthService.resendVerification).toHaveBeenCalledWith('test@nomos.ai');
    expect(component.resendIsLoading).toBeFalse();
    expect(component.resendMessage).toBe(elCopy('auth.register.resendMessage'));
  }));
});
