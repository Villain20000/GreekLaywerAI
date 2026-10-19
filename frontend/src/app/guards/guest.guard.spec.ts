import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  convertToParamMap,
  Router,
  UrlTree
} from '@angular/router';
import { guestGuard } from './guest.guard';
import { AuthService } from '../services/auth.service';

describe('guestGuard', () => {
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

  function run(queryParams: Record<string, string> = {}): boolean | UrlTree {
    const route = {
      queryParamMap: convertToParamMap(queryParams)
    } as unknown as ActivatedRouteSnapshot;

    return TestBed.runInInjectionContext(
      () => guestGuard(route, {} as any)
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

  it('lets unauthenticated visitors see the auth page', () => {
    expect(run()).toBeTrue();
    expect(mockRouter.parseUrl).not.toHaveBeenCalled();
  });

  it('redirects authenticated visitors to /chat by default', () => {
    token = 'jwt-test';
    const result = run() as unknown as { parsedUrl: string };
    expect(result.parsedUrl).toBe('/chat');
  });

  it('honours a valid same-app returnUrl', () => {
    token = 'jwt-test';
    const result = run({ returnUrl: '/documents?page=2' }) as unknown as {
      parsedUrl: string;
    };
    expect(result.parsedUrl).toBe('/documents?page=2');
  });

  it('rejects an external returnUrl and falls back to /chat', () => {
    token = 'jwt-test';
    const result = run({ returnUrl: 'https://evil.example' }) as unknown as {
      parsedUrl: string;
    };
    expect(result.parsedUrl).toBe('/chat');
  });

  it('rejects a protocol-relative returnUrl and falls back to /chat', () => {
    token = 'jwt-test';
    const result = run({ returnUrl: '//evil.example' }) as unknown as {
      parsedUrl: string;
    };
    expect(result.parsedUrl).toBe('/chat');
  });

  it('does not bounce an authenticated user back to /login or /register', () => {
    token = 'jwt-test';
    expect((run({ returnUrl: '/login' }) as unknown as { parsedUrl: string }).parsedUrl).toBe('/chat');
    expect((run({ returnUrl: '/register' }) as unknown as { parsedUrl: string }).parsedUrl).toBe('/chat');
  });
});
