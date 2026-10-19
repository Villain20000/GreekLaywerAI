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
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token-abc');
  });

  it('should include q/limit/offset on listUsers and return the page envelope', (done) => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          users: [{ id: 2, email: 'lawyer@nomos.ai', role: 'user', subscription_tier: 'basic', created_at: '2025-01-02' }],
          total: 42,
          limit: 25,
          offset: 25
        })
      } as Response)
    );

    service.listUsers({ q: 'lawyer', limit: 25, offset: 25 }).subscribe({
      next: (page) => {
        const [url] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
        expect(url).toContain('/api/admin/users?');
        expect(url).toContain('q=lawyer');
        expect(url).toContain('limit=25');
        expect(url).toContain('offset=25');
        expect(page.users.length).toBe(1);
        expect(page.total).toBe(42);
        expect(page.offset).toBe(25);
        done();
      },
      error: done.fail
    });
  });

  it('should default total to the returned length for a legacy users-only body', (done) => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ users: [{ id: 1 }, { id: 2 }] })
      } as Response)
    );

    service.listUsers().subscribe({
      next: (page) => {
        expect(page.total).toBe(2);
        expect(page.limit).toBe(2);
        expect(page.offset).toBe(0);
        done();
      },
      error: done.fail
    });
  });

  it('should build the audit-log query from filter + pagination params', (done) => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          auditLog: [{ id: 1, action: 'admin.role_changed' }],
          total: 1,
          limit: 50,
          offset: 0
        })
      } as Response)
    );

    service.listAuditLog({
      userId: 2,
      action: 'admin.role_changed',
      limit: 50,
      offset: 0
    }).subscribe({
      next: (page) => {
        const [url, init] = (window.fetch as jasmine.Spy).calls.mostRecent().args;
        expect(url).toContain('/api/admin/audit-log?');
        expect(url).toContain('userId=2');
        expect(url).toContain('action=admin.role_changed');
        expect(url).toContain('limit=50');
        expect(url).toContain('offset=0');
        expect(init.method).toBe('GET');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token-abc');
        expect(page.auditLog.length).toBe(1);
        expect(page.total).toBe(1);
        done();
      },
      error: done.fail
    });
  });

  it('should surface the server error text on audit-log failures', (done) => {
    (window.fetch as jasmine.Spy).and.returnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'boom' })
      } as Response)
    );

    service.listAuditLog().subscribe({
      next: () => done.fail('expected an error'),
      error: (err) => {
        expect(err.message).toBe('boom');
        done();
      }
    });
  });
});
