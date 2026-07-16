import { TestBed } from '@angular/core/testing';
import { AdminService } from './admin.service';
import { AuthService } from './auth.service';
import { Router } from '@angular/router';

describe('AdminService', () => {
  let service: AdminService;
  let authStub: { tokenValue: string | null; logout: jasmine.Spy };
  let routerStub: { navigate: jasmine.Spy };
  let originalFetch: typeof fetch;

  beforeEach(() => {
    authStub = {
      tokenValue: 'test-token-abc',
      logout: jasmine.createSpy('logout')
    };
    routerStub = { navigate: jasmine.createSpy('navigate') };

    TestBed.configureTestingModule({
      providers: [
        AdminService,
        { provide: AuthService, useValue: authStub },
        { provide: Router, useValue: routerStub }
      ]
    });

    service = TestBed.inject(AdminService);

    originalFetch = window.fetch;
    window.fetch = jasmine.createSpy('fetch') as unknown as typeof fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should send the Bearer token on listUsers', () => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ users: [] })
      } as Response)
    );

    service.listUsers().subscribe({
      next: () => {},
      error: () => {}
    });

    expect(window.fetch).toHaveBeenCalled();
    const [url, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
    expect(url).toContain('/api/admin/users');
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe('Bearer test-token-abc');
  });
});
