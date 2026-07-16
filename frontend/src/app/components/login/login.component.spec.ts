import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { LoginComponent } from './login.component';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { By } from '@angular/platform-browser';

/**
 * Mirror the discriminated LoginResult returns that AuthService.login
 * actually produces. The old spec used a bare `boolean`, which made
 * component.error silently `undefined` on the failure-path assertion
 * ("expect component.error toBe 'Invalid credentials'") and had no way
 * to exercise the unverified branch.
 */
type LoginResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'invalid_credentials' | 'unverified' | 'network' | 'server';
      error: string;
      status: number;
    };

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let mockAuthService: {
    login: jasmine.Spy;
    resendVerification: jasmine.Spy;
  };
  let mockRouter: { navigate: jasmine.Spy };

  beforeEach(async () => {
    mockAuthService = {
      login: jasmine
        .createSpy<(email: string, password: string) => Promise<LoginResult>>('login')
        .and.returnValue(Promise.resolve({ ok: true })),
      resendVerification: jasmine
        .createSpy<(email: string) => Promise<{ ok: true } | { ok: false; error: string; status: number }>>(
          'resendVerification'
        )
        .and.returnValue(Promise.resolve({ ok: true }))
    };

    mockRouter = {
      navigate: jasmine.createSpy('navigate')
    };

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: Router, useValue: mockRouter }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should show an inline error if fields are empty', async () => {
    component.email = '';
    component.password = '';
    await component.onSubmit();
    expect(component.error).toBe('Please fill in all fields');
    expect(mockAuthService.login).not.toHaveBeenCalled();
  });

  it('should navigate to /chat on successful login', fakeAsync(() => {
    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();

    tick();

    expect(mockAuthService.login).toHaveBeenCalledWith('test@nomos.ai', 'password');
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/chat']);
    expect(component.error).toBe('');
    expect(component.isLoading).toBeFalse();
  }));

  it('should surface a generic Invalid credentials error and keep the resend panel hidden', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_credentials',
        error: 'Invalid credentials',
        status: 400
      })
    );

    component.email = 'wrong@nomos.ai';
    component.password = 'wrong';
    component.onSubmit();

    tick();

    expect(component.error).toBe('Invalid credentials');
    expect(component.isLoading).toBeFalse();
    expect(component.showResend).toBeFalse();
  }));

  it('should expose the resend-verification panel on the unverified branch', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        error: 'Email not verified. Check your inbox for the verification link.',
        status: 400
      })
    );

    component.email = 'unverified@nomos.ai';
    component.password = 'whatever';
    component.onSubmit();

    tick();

    expect(component.showResend).toBeTrue();
    expect(component.error).toContain('Email not verified');
  }));

  it('should call resendVerification when the resend CTA is clicked', fakeAsync(() => {
    component.email = 'unverified@nomos.ai';
    component.showResend = true;
    component.resendMessage = '';

    component.onResend();
    tick();

    expect(mockAuthService.resendVerification).toHaveBeenCalledWith('unverified@nomos.ai');
    expect(component.resendIsLoading).toBeFalse();
    expect(component.resendMessage).toContain('If that email is registered');
  }));

  it('starts with the password hidden and toggles via togglePasswordVisibility', () => {
    expect(component.showPassword).toBeFalse();

    component.togglePasswordVisibility();
    expect(component.showPassword).toBeTrue();

    component.togglePasswordVisibility();
    expect(component.showPassword).toBeFalse();
  });

  it('does not attempt to log in when fields are empty, even if the user mashes Enter', async () => {
    component.email = '  ';
    component.password = '  ';
    await component.onSubmit();

    expect(mockAuthService.login).not.toHaveBeenCalled();
    expect(component.error).toBe('Please fill in all fields');
  });

  it('does not auto-route when the server reports a non-credential, non-unverified failure', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'server',
        error: 'Login failed (HTTP 503)',
        status: 503
      })
    );

    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();
    tick();

    expect(component.error).toContain('Login failed (HTTP 503)');
    expect(component.showResend).toBeFalse();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  // ── DOM-level assertions: drives the rendered template via debugElement
  // so future regressions in the binder wiring (peek-btn click handler,
  // (keyup.enter) on email, inline-link *ngIf kind-gate) actually fail.

  it('peek-btn DOM click toggles showPassword', () => {
    expect(component.showPassword).toBeFalse();
    const peekBtn = fixture.debugElement.query(By.css('.peek-btn'));
    expect(peekBtn).not.toBeNull();

    peekBtn.nativeElement.click();
    expect(component.showPassword).toBeTrue();

    peekBtn.nativeElement.click();
    expect(component.showPassword).toBeFalse();
  });

  it('updates the password input type in lockstep with showPassword', () => {
    expect(component.showPassword).toBeFalse();
    const passwordInput = fixture.debugElement.query(By.css('#login-password'));
    expect(passwordInput.nativeElement.getAttribute('type')).toBe('password');

    component.togglePasswordVisibility();
    fixture.detectChanges();

    expect(passwordInput.nativeElement.getAttribute('type')).toBe('text');
  });

  it('dispatches a synthetic Enter on the email input → onSubmit fires', fakeAsync(() => {
    component.email = 'a@b.com';
    component.password = '';

    const emailInput = fixture.debugElement.query(By.css('#login-email'));
    emailInput.nativeElement.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
    );
    tick();

    // Empty password short-circuit: lastFailedKind is null, error reads
    // 'Please fill in all fields', and AuthService.login is NOT called.
    expect(component.error).toBe('Please fill in all fields');
    expect(component.lastFailedKind).toBeNull();
    expect(mockAuthService.login).not.toHaveBeenCalled();
  }));

  it('renders the inline Forgot it? link only for kind=invalid_credentials (not for unverified)', fakeAsync(() => {
    // First assertion: unverified branch does NOT surface the inline link.
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        error: 'Email not verified. Check your inbox for the verification link.',
        status: 400
      })
    );
    component.email = 'unverified@nomos.ai';
    component.password = 'pw';
    component.onSubmit();
    tick();
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.css('.inline-link'))).toBeNull();

    // Second assertion: invalid_credentials branch DOES surface it.
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_credentials',
        error: 'Invalid credentials',
        status: 400
      })
    );
    component.onSubmit();
    tick();
    fixture.detectChanges();

    const inlineLink = fixture.debugElement.query(By.css('.inline-link'));
    expect(inlineLink).not.toBeNull();
    expect(inlineLink.nativeElement.textContent).toContain('Forgot it?');
    expect(inlineLink.nativeElement.getAttribute('href')).toBe('/forgot-password');
  }));

  it('renders the resend panel only for kind=unverified and exposes the resend CTA', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        error: 'Email not verified. Check your inbox for the verification link.',
        status: 400
      })
    );
    component.email = 'unverified@nomos.ai';
    component.password = 'pw';
    component.onSubmit();
    tick();
    fixture.detectChanges();

    const resendPanel = fixture.debugElement.query(By.css('.resend-panel'));
    expect(resendPanel).not.toBeNull();
    const resendBtn = resendPanel.query(By.css('button.secondary'));
    expect(resendBtn).not.toBeNull();
    expect(resendBtn.nativeElement.textContent).toContain('Resend verification email');
  }));

  it('renders both navigation affordances (forgot + register) as routerLink <a> in the auth-links footer', () => {
    const links = fixture.debugElement.queryAll(By.css('.auth-links a.auth-link'));
    expect(links.length).toBe(2);
    const hrefs = links.map((d) => d.nativeElement.getAttribute('href'));
    expect(hrefs).toContain('/forgot-password');
    expect(hrefs).toContain('/register');
    expect(links[0].nativeElement.textContent).toContain('Forgot password?');
    expect(links[1].nativeElement.textContent).toContain('Create account');
  });
});
