import { TestBed } from '@angular/core/testing';
import { AuthService, AuthUser } from './auth.service';
import { Router } from '@angular/router';

describe('AuthService', () => {
  let service: AuthService;
  let mockRouter: any;

  beforeEach(() => {
    mockRouter = {
      navigate: jasmine.createSpy('navigate')
    };
    
    // Clear localStorage before each test. Both keys matter: the service
    // constructor restores BOTH the token and the cached user, and a previous
    // spec's background refreshFromServer() can leave nomos_user behind.
    localStorage.removeItem('nomos_token');
    localStorage.removeItem('nomos_user');

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: Router, useValue: mockRouter }
      ]
    });
    service = TestBed.inject(AuthService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should start with a null token if localStorage is empty', () => {
    expect(service.tokenValue).toBeNull();
  });

  it('should retrieve token from localStorage on initialization', () => {
    localStorage.setItem('nomos_token', 'test-token');
    
    // Create a new service instance to trigger the constructor logic
    const newService = new AuthService(mockRouter);
    expect(newService.tokenValue).toEqual('test-token');
  });

  it('should clear token and navigate to login on logout()', () => {
    localStorage.setItem('nomos_token', 'test-token');
    service = new AuthService(mockRouter); // re-init to pick up token

    service.logout();

    expect(localStorage.getItem('nomos_token')).toBeNull();
    expect(service.tokenValue).toBeNull();
    expect(mockRouter.navigate).toHaveBeenCalledWith(['/login']);
  });

  describe('register()', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    // Phase 24: register no longer mints a JWT. Success returns
    // `{ ok: true, requires_verification: true, user }` and nothing is
    // stored in localStorage — the JWT comes later from /verify-email.
    it('should return requires_verification on a 200 response and store NO token', async () => {
      const fakeUser: AuthUser = {
        id: 1,
        email: 'new@nomos.ai',
        role: 'user',
        subscription_tier: 'basic',
        token_version: 1,
        verified_at: null
      };
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.returnValue(
          Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ok: true,
                requires_verification: true,
                user: fakeUser
              })
          } as Response)
        );

      const result = await service.register('new@nomos.ai', 'password123');
      expect(result).toEqual({
        ok: true,
        requires_verification: true,
        user: fakeUser
      });
      // No token is issued at registration time.
      expect(localStorage.getItem('nomos_token')).toBeNull();
      expect(service.tokenValue).toBeNull();
      expect(service.userValue).toBeNull();
    });

    it('should return ok:false with the server error message on a 4xx', async () => {
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.returnValue(
          Promise.resolve({
            ok: false,
            status: 400,
            json: () => Promise.resolve({ error: 'User already exists' })
          } as Response)
        );

      const result = await service.register('taken@nomos.ai', 'password123');
      expect(result.ok).toBeFalse();
      expect(result).toEqual(jasmine.objectContaining({
        ok: false,
        error: 'User already exists',
        status: 400
      }));
      expect(localStorage.getItem('nomos_token')).toBeNull();
    });

    it('should return ok:false with a network error message when fetch throws', async () => {
      globalThis.fetch = jasmine.createSpy('fetch').and.rejectWith(new Error('boom'));

      const result = await service.register('a@b.com', 'password123');
      expect(result.ok).toBeFalse();
      expect(result).toEqual(jasmine.objectContaining({
        ok: false,
        error: 'boom',
        status: 0
      }));
      expect(service.tokenValue).toBeNull();
    });
  });

  describe('changePassword()', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      // Seed a token so the service picks it up at construction time.
      localStorage.setItem('nomos_token', 'jwt-abc');
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should POST to /change-password and return ok:true on 200', async () => {
      // After construction the service fires refreshFromServer() in the
      // background. We only want to assert on the explicit changePassword()
      // call, so override globalThis.fetch first with a fallback that answers
      // every call identically, then assert on URL+method to disambiguate.
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(
        () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true })
          } as unknown as Response)
      );

      service = new AuthService(mockRouter);

      const result = await service.changePassword('oldPassword123', 'newPassword456');
      expect(result.ok).toBeTrue();

      // Find the POST call specifically (the constructor's GET /me is also
      // routed through the same spy). URLs are same-origin relative because
      // environment.apiBaseUrl is ''.
      const calls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/auth/change-password' &&
            (init as RequestInit | undefined)?.method === 'POST'
        );
      expect(calls.length).toBe(1);
    });

    it('should surface server error message on a 4xx', async () => {
      spyOn(globalThis, 'fetch').and.callFake(
        () =>
          Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ error: 'Password change failed' })
          } as unknown as Response)
      );

      service = new AuthService(mockRouter);

      const result = await service.changePassword('oldPassword123', 'newPassword456');
      expect(result.ok).toBeFalse();
      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          error: 'Password change failed',
          status: 400
        })
      );
    });

    it('should return ok:false on a network error', async () => {
      spyOn(globalThis, 'fetch').and.rejectWith(new Error('offline'));

      service = new AuthService(mockRouter);

      const result = await service.changePassword('oldPassword123', 'newPassword456');
      expect(result.ok).toBeFalse();
      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          error: 'offline',
          status: 0
        })
      );
    });
  });

  // ------------------------------------------------------------------
  // Phase 30: email change. The request route re-verifies the current
  // password; the verification route is a one-time-token endpoint that
  // swaps the JWT exactly like verifyEmail().
  // ------------------------------------------------------------------
  describe('changeEmail()', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      localStorage.setItem('nomos_token', 'jwt-abc');
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      localStorage.removeItem('nomos_token');
      localStorage.removeItem('nomos_user');
    });

    it('POSTs /api/auth/change-email with the bearer token and both fields', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, requires_verification: true })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      const result = await service.changeEmail('new@nomos.ai', 'password123');

      expect(result.ok).toBeTrue();
      const calls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/auth/change-email' &&
            (init as RequestInit | undefined)?.method === 'POST'
        );
      expect(calls.length).toBe(1);
      const init = calls[0][1] as RequestInit;
      expect(init.body).toBe(
        JSON.stringify({ newEmail: 'new@nomos.ai', currentPassword: 'password123' })
      );
      expect((init.headers as Headers).get('Authorization')).toBe('Bearer jwt-abc');
    });

    it('maps a 409 email_taken to kind=email_taken', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: 'Email already in use', code: 'email_taken' })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      const result = await service.changeEmail('taken@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'email_taken',
          code: 'email_taken',
          status: 409
        })
      );
    });

    it('returns kind=network when fetch rejects', async () => {
      spyOn(globalThis, 'fetch').and.rejectWith(new Error('offline'));
      service = new AuthService(mockRouter);

      const result = await service.changeEmail('new@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'network', status: 0 })
      );
    });
  });

  describe('verifyEmailChange()', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      localStorage.removeItem('nomos_token');
      localStorage.removeItem('nomos_user');
    });

    it('swaps the returned JWT + user into storage like verifyEmail()', async () => {
      const newUser: AuthUser = {
        id: 1,
        email: 'new@nomos.ai',
        role: 'user',
        subscription_tier: 'basic',
        token_version: 5,
        verified_at: '2026-01-01T00:00:00.000Z'
      };
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, token: 'jwt-new', user: newUser })
        } as unknown as Response)
      );

      const result = await service.verifyEmailChange('a'.repeat(64));

      expect(result).toEqual({ ok: true, token: 'jwt-new', user: newUser });
      expect(localStorage.getItem('nomos_token')).toBe('jwt-new');
      expect(JSON.parse(localStorage.getItem('nomos_user')!)).toEqual(newUser);
      expect(service.tokenValue).toBe('jwt-new');
      expect(service.userValue?.email).toBe('new@nomos.ai');

      const calls = fetchSpy.calls
        .allArgs()
        .filter(([url]) => url === '/api/auth/verify-email-change');
      expect(calls.length).toBe(1);
    });

    it('maps an invalid_token rejection', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            error: 'Invalid or expired email-change link',
            code: 'invalid_token'
          })
        } as unknown as Response)
      );

      const result = await service.verifyEmailChange('b'.repeat(64));

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'invalid_token',
          code: 'invalid_token',
          status: 400
        })
      );
      expect(localStorage.getItem('nomos_token')).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Rate limiting: a 429 is classified by HTTP STATUS, never by the body.
  // The backend rate-limits the auth surface (POST /api/auth/login at
  // 10/min per IP) and its limiter answers
  // `{ error: 'Too many requests, please try again later.' }` — NO `code`
  // at all — so the client used to report a rate limit as a server error.
  // ------------------------------------------------------------------
  describe('rate-limit classification (HTTP 429)', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    const stubResponse = (status: number, body: unknown): void => {
      globalThis.fetch = jasmine
        .createSpy('fetch')
        .and.returnValue(
          Promise.resolve({
            ok: false,
            status,
            json: () => Promise.resolve(body)
          } as Response)
        );
    };

    it('maps a code-less 429 on login to kind=rate_limited', async () => {
      stubResponse(429, { error: 'Too many requests, please try again later.' });

      const result = await service.login('u@nomos.ai', 'pw');

      expect(result).toEqual(
        jasmine.objectContaining({
          ok: false,
          kind: 'rate_limited',
          code: null,
          status: 429
        })
      );
    });

    it('maps a 429 that carries a code to kind=rate_limited (the status wins)', async () => {
      stubResponse(429, { error: 'Too many requests', code: 'server_error' });

      const result = await service.login('u@nomos.ai', 'pw');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'rate_limited', status: 429 })
      );
    });

    it('maps a code-less 429 on register to kind=rate_limited', async () => {
      stubResponse(429, { error: 'Too many requests, please try again later.' });

      const result = await service.register('u@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'rate_limited', status: 429 })
      );
    });

    it('maps a code-less 429 on resend-verification to kind=rate_limited', async () => {
      stubResponse(429, { error: 'Too many requests, please try again later.' });

      const result = await service.resendVerification('u@nomos.ai');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'rate_limited', status: 429 })
      );
    });

    it('still classifies a code-less 400 as invalid_request', async () => {
      stubResponse(400, { error: 'Bad request' });

      const result = await service.register('u@nomos.ai', 'password123');

      expect(result).toEqual(
        jasmine.objectContaining({ ok: false, kind: 'invalid_request', status: 400 })
      );
    });
  });

  // P0-2: the GDPR endpoints live under /api/gdpr, NOT /api/auth. These
  // specs pin the URLs + request shape against backend/src/routes/gdpr.js.
  describe('GDPR data export + account deletion', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      localStorage.setItem('nomos_token', 'jwt-abc');
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      localStorage.removeItem('nomos_token');
      localStorage.removeItem('nomos_user');
    });

    it('exportData() GETs /api/gdpr/export with the bearer token', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ user: { id: 1 }, messages: [] })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      const data = await service.exportData();

      expect(data).toEqual({ user: { id: 1 }, messages: [] });
      // environment.apiBaseUrl is '' (same-origin): the URL on the wire is
      // relative, not an absolute localhost:3000 URL.
      const exportCalls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/gdpr/export' &&
            ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
        );
      expect(exportCalls.length).toBe(1);
      // apiFetch sends a Headers instance, not a plain record.
      const init = exportCalls[0][1] as RequestInit;
      expect((init.headers as Headers).get('Authorization')).toBe('Bearer jwt-abc');
    });

    it('exportData() surfaces the server error on non-OK responses', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Unauthorized' })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      await expectAsync(service.exportData()).toBeRejectedWithError('Unauthorized');
    });

    it('deleteAccount() schedules deletion, returns the deadline, and keeps the session', async () => {
      const scheduledFor = '2026-10-20T12:00:00.000Z';
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            deletionScheduledFor: scheduledFor,
            graceHours: 24
          })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      const result = await service.deleteAccount('user@nomos.ai');

      expect(result).toEqual({
        ok: true,
        deletionScheduledFor: scheduledFor,
        graceHours: 24
      });
      const deleteCalls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/gdpr/account' &&
            (init as RequestInit | undefined)?.method === 'DELETE'
        );
      expect(deleteCalls.length).toBe(1);
      const init = deleteCalls[0][1] as RequestInit;
      expect(init.body).toBe(JSON.stringify({ confirm: true, email: 'user@nomos.ai' }));
      // Scheduling must not sign the user out — the profile stays usable
      // until the deadline so the deletion can be cancelled.
      expect(localStorage.getItem('nomos_token')).toBe('jwt-abc');
      expect(mockRouter.navigate).not.toHaveBeenCalledWith(['/login']);
    });

    it('deleteAccount() surfaces the server error on non-OK responses', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ error: 'Email does not match the account email' })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      await expectAsync(service.deleteAccount('other@nomos.ai'))
        .toBeRejectedWithError('Email does not match the account email');
    });

    it('getDeletionStatus() GETs /api/gdpr/deletion-status with the bearer token', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ deletionScheduledFor: '2026-10-20T12:00:00.000Z' })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      const status = await service.getDeletionStatus();

      expect(status).toEqual({ deletionScheduledFor: '2026-10-20T12:00:00.000Z' });
      const calls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/gdpr/deletion-status' &&
            ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET'
        );
      expect(calls.length).toBe(1);
      expect(((calls[0][1] as RequestInit).headers as Headers).get('Authorization'))
        .toBe('Bearer jwt-abc');
    });

    it('getDeletionStatus() normalizes a missing deadline to null', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ deletionScheduledFor: null })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      await expectAsync(service.getDeletionStatus())
        .toBeResolvedTo({ deletionScheduledFor: null });
    });

    it('cancelAccountDeletion() POSTs /api/gdpr/cancel-deletion with the bearer token', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ok: true })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      await service.cancelAccountDeletion();

      const calls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === '/api/gdpr/cancel-deletion' &&
            (init as RequestInit | undefined)?.method === 'POST'
        );
      expect(calls.length).toBe(1);
      expect(((calls[0][1] as RequestInit).headers as Headers).get('Authorization'))
        .toBe('Bearer jwt-abc');
      // Cancellation restores the account; the session is still valid.
      expect(localStorage.getItem('nomos_token')).toBe('jwt-abc');
    });

    it('cancelAccountDeletion() surfaces a 409 when nothing is scheduled', async () => {
      spyOn(globalThis, 'fetch').and.callFake(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: 'No account deletion is scheduled' })
        } as unknown as Response)
      );
      service = new AuthService(mockRouter);

      await expectAsync(service.cancelAccountDeletion())
        .toBeRejectedWithError('No account deletion is scheduled');
    });
  });
});
