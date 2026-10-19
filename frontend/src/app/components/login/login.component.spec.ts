import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { LoginComponent } from './login.component';
import {
  AUTH_ERROR_CODE_TO_KIND,
  AUTH_ERROR_I18N_KEYS,
  AuthErrorCode,
  AuthErrorKind,
  AuthService,
  authErrorMessage,
  LoginResult,
  SimpleAuthResult
} from '../../services/auth.service';
import { Router, provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { By } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { lookupTranslation, provideTestTranslate } from '../../i18n/testing';

/**
 * Greek copy for a dictionary key.
 *
 * The dictionary is the source of truth for the rendered wording, so the
 * assertions below resolve the key instead of hard-coding a literal. Throws
 * when the key is missing so a dictionary regression fails the spec loudly
 * instead of silently comparing against `undefined`.
 */
function elCopy(key: string): string {
  const raw = lookupTranslation('el', key);
  if (raw === undefined) {
    throw new Error(`Missing i18n key: ${key}`);
  }
  return raw;
}

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let mockAuthService: {
    login: jasmine.Spy;
    resendVerification: jasmine.Spy;
  };
  let mockRouter: Router;

  beforeEach(async () => {
    mockAuthService = {
      login: jasmine
        .createSpy<(email: string, password: string) => Promise<LoginResult>>('login')
        .and.returnValue(Promise.resolve({ ok: true })),
      resendVerification: jasmine
        .createSpy<(email: string) => Promise<SimpleAuthResult>>(
          'resendVerification'
        )
        .and.returnValue(Promise.resolve({ ok: true }))
    };

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        // Real Router via provideRouter + spy on navigate: RouterLink needs a
        // working ActivatedRoute/Router graph to render hrefs, while the specs
        // only care about programmatic navigate() calls.
        provideRouter(
          [{ path: 'login', component: LoginComponent }],
          withDisabledInitialNavigation()
        ),
        // 2-8 (i18n): the form template uses the `translate` pipe and the
        // component injects TranslateService, so the spec needs the
        // ngx-translate providers (TranslateStore is not `providedIn: 'root'`
        // in @ngx-translate/core@16).
        ...provideTestTranslate()
      ]
    }).compileComponents();

    mockRouter = TestBed.inject(Router);
    spyOn(mockRouter, 'navigate').and.returnValue(Promise.resolve(true));
    spyOn(mockRouter, 'navigateByUrl').and.returnValue(Promise.resolve(true));

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
    expect(component.error).toBe(elCopy('common.fillAll'));
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

  // ── 2-7: returnUrl round-trip ──────────────────────────────────────────

  it('reads a valid returnUrl from the login query string', async () => {
    const navigateByUrlSpy = mockRouter.navigateByUrl as jasmine.Spy;
    navigateByUrlSpy.and.callThrough();
    await mockRouter.navigateByUrl(
      '/login?returnUrl=%2Fdocuments%3Fpage%3D2'
    );
    navigateByUrlSpy.and.returnValue(Promise.resolve(true));

    expect(component.postLoginReturnUrl()).toBe('/documents?page=2');
  });

  it('navigates to the validated returnUrl after a successful login', fakeAsync(() => {
    spyOn(component, 'postLoginReturnUrl').and.returnValue('/documents?page=2');

    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();

    tick();

    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/documents?page=2');
    expect(mockRouter.navigate).not.toHaveBeenCalledWith(['/chat']);
  }));

  it('falls back to /chat when the returnUrl is external (open redirect rejected)', fakeAsync(() => {
    spyOn(component, 'postLoginReturnUrl').and.returnValue(null);

    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();

    tick();

    expect(mockRouter.navigate).toHaveBeenCalledWith(['/chat']);
    expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
  }));

  it('returns null from postLoginReturnUrl for a crafted external target', async () => {
    const navigateByUrlSpy = mockRouter.navigateByUrl as jasmine.Spy;
    navigateByUrlSpy.and.callThrough();
    await mockRouter.navigateByUrl(
      '/login?returnUrl=https%3A%2F%2Fevil.example%2Fsteal'
    );
    navigateByUrlSpy.and.returnValue(Promise.resolve(true));

    expect(component.postLoginReturnUrl()).toBeNull();
  });

  it('should surface a generic Invalid credentials error and keep the resend panel hidden', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'invalid_credentials',
        code: 'invalid_credentials',
        error: 'Invalid credentials',
        status: 400
      })
    );

    component.email = 'wrong@nomos.ai';
    component.password = 'wrong';
    component.onSubmit();

    tick();

    // The rendered copy is the TRANSLATED one picked by the backend's
    // `code` — the raw English server prose never reaches the user.
    expect(component.error).toBe(elCopy('auth.errors.invalidCredentials'));
    expect(component.error).not.toContain('Invalid credentials');
    expect(component.isLoading).toBeFalse();
    expect(component.showResend).toBeFalse();
  }));

  it('should expose the resend-verification panel on the unverified branch', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        code: 'unverified_email',
        error: 'Email not verified. Check your inbox for the verification link.',
        status: 400
      })
    );

    component.email = 'unverified@nomos.ai';
    component.password = 'whatever';
    component.onSubmit();

    tick();

    expect(component.showResend).toBeTrue();
    expect(component.error).toBe(elCopy('auth.errors.unverifiedEmail'));
    expect(component.error).not.toContain('Email not verified');
  }));

  it('should call resendVerification when the resend CTA is clicked', fakeAsync(() => {
    component.email = 'unverified@nomos.ai';
    component.showResend = true;
    component.resendMessage = '';

    component.onResend();
    tick();

    expect(mockAuthService.resendVerification).toHaveBeenCalledWith('unverified@nomos.ai');
    expect(component.resendIsLoading).toBeFalse();
    expect(component.resendMessage).toBe(elCopy('auth.login.resendMessage'));
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
    expect(component.error).toBe(elCopy('common.fillAll'));
  });

  it('does not auto-route when the server reports a non-credential, non-unverified failure', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'server',
        code: 'server_error',
        error: 'Login failed (HTTP 503)',
        status: 503
      })
    );

    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();
    tick();

    expect(component.error).toBe(elCopy('auth.errors.serverError'));
    expect(component.error).not.toContain('Login failed');
    expect(component.showResend).toBeFalse();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  }));

  it('shows the rate-limit copy — never the server-error copy — for a 429', fakeAsync(() => {
    // The backend rate-limits POST /api/auth/login at 10/min per IP and
    // answers with a code-less body; the client classifies it by status.
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'rate_limited',
        code: null,
        error: 'Too many requests, please try again later.',
        status: 429
      })
    );

    component.email = 'test@nomos.ai';
    component.password = 'password';
    component.onSubmit();
    tick();

    expect(component.error).toBe(elCopy('common.tooManyRequests'));
    expect(component.error).not.toBe(elCopy('auth.errors.serverError'));
    expect(component.error).not.toContain('Too many requests');
    expect(component.lastFailedKind).toBe('rate_limited');
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

    // Empty password short-circuit: lastFailedKind is null, error reads the
    // translated "fill in all fields" copy, and AuthService.login is NOT
    // called.
    expect(component.error).toBe(elCopy('common.fillAll'));
    expect(component.lastFailedKind).toBeNull();
    expect(mockAuthService.login).not.toHaveBeenCalled();
  }));

  it('renders the inline Forgot it? link only for kind=invalid_credentials (not for unverified)', fakeAsync(() => {
    // First assertion: unverified branch does NOT surface the inline link.
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        code: 'unverified_email',
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
        code: 'invalid_credentials',
        error: 'Invalid credentials',
        status: 400
      })
    );
    component.onSubmit();
    tick();
    fixture.detectChanges();

    const inlineLink = fixture.debugElement.query(By.css('.inline-link'));
    expect(inlineLink).not.toBeNull();
    expect(inlineLink.nativeElement.textContent).toContain(elCopy('auth.login.forgotIt'));
    expect(inlineLink.nativeElement.getAttribute('href')).toBe('/forgot-password');
  }));

  it('renders the resend panel only for kind=unverified and exposes the resend CTA', fakeAsync(() => {
    mockAuthService.login.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'unverified',
        code: 'unverified_email',
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
    expect(resendBtn.nativeElement.textContent).toContain(elCopy('auth.login.resend'));
  }));

  it('renders both navigation affordances (forgot + register) as routerLink <a> in the auth-links footer', () => {
    const links = fixture.debugElement.queryAll(By.css('.auth-links a.auth-link'));
    expect(links.length).toBe(2);
    const hrefs = links.map((d) => d.nativeElement.getAttribute('href'));
    expect(hrefs).toContain('/forgot-password');
    expect(hrefs).toContain('/register');
    expect(links[0].nativeElement.textContent).toContain(elCopy('auth.login.forgotPassword'));
    expect(links[1].nativeElement.textContent).toContain(elCopy('auth.login.createAccount'));
  });

  it('shows the translated copy — never the raw English prose — when the resend request fails', fakeAsync(() => {
    mockAuthService.resendVerification.and.returnValue(
      Promise.resolve({
        ok: false,
        kind: 'network',
        code: null,
        error: 'Failed to fetch',
        status: 0
      })
    );

    component.email = 'unverified@nomos.ai';
    component.onResend();
    tick();

    expect(component.resendIsLoading).toBeFalse();
    expect(component.resendMessage).toBe(elCopy('auth.errors.network'));
    expect(component.resendMessage).not.toContain('Failed to fetch');
  }));

  // ── AuthService classification: the contract this component relies on ──

  /**
   * The login component branches on `kind`, and `kind` is derived from the
   * backend's machine-readable `code` — never from the English prose.
   * These specs drive the REAL AuthService against a stubbed fetch so the
   * classification itself is pinned, not just the component's reaction to
   * a hand-written mock.
   */
  describe('AuthService code-driven failure classification', () => {
    const originalFetch = globalThis.fetch;
    let service: AuthService;

    const stubResponse = (status: number, body: unknown): void => {
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.returnValue(
          Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body)
          } as Response)
        );
    };

    const expectFailure = (
      result: LoginResult,
      kind: AuthErrorKind,
      code: AuthErrorCode | null
    ): void => {
      expect(result).toEqual(jasmine.objectContaining({ ok: false, kind, code }));
    };

    beforeEach(() => {
      localStorage.removeItem('nomos_token');
      localStorage.removeItem('nomos_user');
      service = new AuthService({
        navigate: jasmine.createSpy('navigate')
      } as unknown as Router);
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      localStorage.removeItem('nomos_token');
      localStorage.removeItem('nomos_user');
    });

    it('maps code=unverified_email to kind=unverified', async () => {
      stubResponse(400, {
        error: 'Email not verified. Check your inbox for the verification link.',
        code: 'unverified_email'
      });

      const result = await service.login('u@nomos.ai', 'pw');

      expectFailure(result, 'unverified', 'unverified_email');
      expect(result).toEqual(jasmine.objectContaining({ status: 400 }));
    });

    it('maps code=invalid_credentials to kind=invalid_credentials', async () => {
      stubResponse(400, {
        error: 'Invalid credentials',
        code: 'invalid_credentials'
      });

      const result = await service.login('u@nomos.ai', 'bad');

      expectFailure(result, 'invalid_credentials', 'invalid_credentials');
    });

    it('maps code=server_error to kind=server', async () => {
      stubResponse(500, { error: 'Server error', code: 'server_error' });

      const result = await service.login('u@nomos.ai', 'pw');

      expectFailure(result, 'server', 'server_error');
    });

    it('maps a code-less 429 on login to kind=rate_limited', async () => {
      stubResponse(429, { error: 'Too many requests, please try again later.' });

      const result = await service.login('u@nomos.ai', 'pw');

      expectFailure(result, 'rate_limited', null);
      expect(result).toEqual(jasmine.objectContaining({ status: 429 }));
    });

    it('maps a 429 that carries a code to kind=rate_limited (the status wins)', async () => {
      stubResponse(429, { error: 'Too many requests', code: 'server_error' });

      const result = await service.login('u@nomos.ai', 'pw');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'rate_limited', status: 429 })
      );
    });

    it('renders the rate-limit copy — not the server-error copy — for a 429', async () => {
      const translate = TestBed.inject(TranslateService);
      stubResponse(429, { error: 'Too many requests, please try again later.' });

      const result = await service.login('u@nomos.ai', 'pw');
      expect(result.ok).toBeFalse();
      if (result.ok) throw new Error('the login should have been rejected');

      const message = authErrorMessage(translate, result);
      expect(message).toBe(elCopy('common.tooManyRequests'));
      expect(message).not.toBe(elCopy('auth.errors.serverError'));
      expect(message).not.toContain('Too many requests');
    });

    it('still classifies the legacy "Email not verified" prose when the server sends no code', async () => {
      stubResponse(400, {
        error: 'Email not verified. Check your inbox for the verification link.'
      });

      const result = await service.login('u@nomos.ai', 'pw');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'unverified', code: null })
      );
    });

    it('falls back to kind=invalid_credentials for a codeless 400', async () => {
      stubResponse(400, { error: 'Invalid credentials' });

      const result = await service.login('u@nomos.ai', 'bad');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'invalid_credentials',
          code: null
        })
      );
    });

    it('maps code=email_taken on register to kind=email_taken', async () => {
      stubResponse(400, { error: 'User already exists', code: 'email_taken' });

      const result = await service.register('taken@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'email_taken',
          code: 'email_taken'
        })
      );
    });

    it('maps code=admin_registration_forbidden on register', async () => {
      stubResponse(403, {
        error: 'Cannot self-register as admin',
        code: 'admin_registration_forbidden'
      });

      const result = await service.register('admin@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'admin_registration_forbidden',
          code: 'admin_registration_forbidden'
        })
      );
    });

    it('maps code=password_change_failed on change-password', async () => {
      stubResponse(400, {
        error: 'Password change failed',
        code: 'password_change_failed'
      });
      localStorage.setItem('nomos_token', 'jwt-abc');

      const result = await service.changePassword('oldPassword123', 'newPassword456');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'password_change_failed',
          code: 'password_change_failed'
        })
      );
    });

    it('maps code=user_not_found on change-password', async () => {
      stubResponse(401, { error: 'User not found', code: 'user_not_found' });
      localStorage.setItem('nomos_token', 'jwt-abc');

      const result = await service.changePassword('oldPassword123', 'newPassword456');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'user_not_found',
          code: 'user_not_found'
        })
      );
    });

    it('maps code=invalid_token on verify-email', async () => {
      stubResponse(400, {
        error: 'Invalid or expired verification link',
        code: 'invalid_token'
      });

      const result = await service.verifyEmail('a'.repeat(64));

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'invalid_token',
          code: 'invalid_token'
        })
      );
    });

    it('maps code=admin_role_required on the magic-link redeem', async () => {
      stubResponse(403, {
        error: 'Administrator role required',
        code: 'admin_role_required'
      });

      const result = await service.verifyMagicLink('magic-token');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'admin_role_required',
          code: 'admin_role_required'
        })
      );
    });

    it('maps code=not_found on the magic-link redeem', async () => {
      stubResponse(404, { error: 'Not found', code: 'not_found' });

      const result = await service.verifyMagicLink('magic-token');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'not_found', code: 'not_found' })
      );
    });

    it('reports kind=network when the request never reaches the server', async () => {
      globalThis.fetch = jasmine.createSpy('fetch').and.rejectWith(new Error('offline'));

      const result = await service.login('u@nomos.ai', 'pw');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'network', code: null, status: 0 })
      );
    });

    it('covers the whole backend code vocabulary and maps every code to a translation', () => {
      // Mirrors backend/src/constants/authErrors.js (frozen vocabulary).
      const backendVocabulary: readonly AuthErrorCode[] = [
        'invalid_credentials',
        'unverified_email',
        'email_taken',
        'admin_registration_forbidden',
        'invalid_token',
        'invalid_request',
        'password_change_failed',
        'user_not_found',
        'admin_role_required',
        'not_found',
        'request_accepted',
        'server_error'
      ];

      expect(Object.keys(AUTH_ERROR_CODE_TO_KIND).sort()).toEqual(
        [...backendVocabulary].sort()
      );
      for (const code of backendVocabulary) {
        const key = AUTH_ERROR_I18N_KEYS[code];
        expect(key).withContext(`i18n key for ${code}`).toBeDefined();
        expect(lookupTranslation('el', key as string))
          .withContext(`el copy for ${code}`)
          .toBeTruthy();
        expect(lookupTranslation('en', key as string))
          .withContext(`en copy for ${code}`)
          .toBeTruthy();
      }
    });
  });
});
