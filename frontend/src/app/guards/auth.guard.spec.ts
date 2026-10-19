import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';

describe('authGuard (returnUrl capture)', () => {
  let mockRouter: { parseUrl: jasmine.Spy };
  let token: string | null;

  function setup(): void {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { get tokenValue() { return token; } } },
        { provide: Router, useValue: mockRouter }
      ]
    });
  }

  function run(url: string): boolean | UrlTree {
    return TestBed.runInInjectionContext(
      () => authGuard({} as any, { url } as any)
    ) as boolean | UrlTree;
  }

  beforeEach(() => {
    token = null;
    mockRouter = {
      parseUrl: jasmine.createSpy('parseUrl').and.callFake(
        (url: string): UrlTree => ({ parsedUrl: url } as unknown as UrlTree)
      )
    };
    setup();
  });

  it('allows authenticated users through without touching the router', () => {
    token = 'jwt-test';
    expect(run('/chat')).toBeTrue();
    expect(mockRouter.parseUrl).not.toHaveBeenCalled();
  });

  it('captures the attempted URL as an encoded returnUrl', () => {
    const result = run('/documents?page=2') as unknown as { parsedUrl: string };
    expect(result.parsedUrl).toBe(
      '/login?returnUrl=%2Fdocuments%3Fpage%3D2'
    );
  });

  it('captures a simple protected path', () => {
    const result = run('/profile') as unknown as { parsedUrl: string };
    expect(result.parsedUrl).toBe('/login?returnUrl=%2Fprofile');
  });

  it('does not leak an external/protocol-relative URL into returnUrl', () => {
    const result = run('//evil.example/steal') as unknown as {
      parsedUrl: string;
    };
    expect(result.parsedUrl).toBe('/login');
  });
});
