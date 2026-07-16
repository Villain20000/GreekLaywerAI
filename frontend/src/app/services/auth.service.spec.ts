import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { Router } from '@angular/router';

describe('AuthService', () => {
  let service: AuthService;
  let mockRouter: any;

  beforeEach(() => {
    mockRouter = {
      navigate: jasmine.createSpy('navigate')
    };
    
    // Clear localStorage before each test
    localStorage.removeItem('nomos_token');

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
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should store token and user on a 200 response', async () => {
      const fakeUser = {
        id: 1,
        email: 'new@nomos.ai',
        role: 'user',
        subscription_tier: 'basic'
      };
      global.fetch = jasmine
        .createSpy('fetch')
        .and.returnValue(
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ token: 'jwt-x', user: fakeUser })
          } as Response)
        );

      const result = await service.register('new@nomos.ai', 'password123');
      expect(result).toEqual({ ok: true });
      expect(localStorage.getItem('nomos_token')).toBe('jwt-x');
      expect(JSON.parse(localStorage.getItem('nomos_user')!)).toEqual(fakeUser);
      expect(service.tokenValue).toBe('jwt-x');
      expect(service.userValue).toEqual(fakeUser);
    });

    it('should return ok:false with the server error message on a 4xx', async () => {
      global.fetch = jasmine
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
      global.fetch = jasmine.createSpy('fetch').and.rejectWith(new Error('boom'));

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
    const originalFetch = global.fetch;

    beforeEach(() => {
      // Seed a token so the service picks it up at construction time.
      localStorage.setItem('nomos_token', 'jwt-abc');
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should POST to /change-password and return ok:true on 200', async () => {
      // After construction the service fires refreshFromServer() in the
      // background. We only want to assert on the explicit changePassword()
      // call, so override global.fetch first with a fallback that answers
      // every call identically, then assert on URL+method to disambiguate.
      const fetchSpy = spyOn(global, 'fetch').and.callFake(
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
      // routed through the same spy).
      const calls = fetchSpy.calls
        .allArgs()
        .filter(
          ([url, init]) =>
            url === 'http://localhost:3000/api/auth/change-password' &&
            (init as RequestInit | undefined)?.method === 'POST'
        );
      expect(calls.length).toBe(1);
    });

    it('should surface server error message on a 4xx', async () => {
      spyOn(global, 'fetch').and.callFake(
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
      spyOn(global, 'fetch').and.rejectWith(new Error('offline'));

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
});
