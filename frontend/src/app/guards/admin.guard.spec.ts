import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { BehaviorSubject, Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { adminGuard } from './admin.guard';
import { AuthService, AuthUser } from '../services/auth.service';

describe('adminGuard (observable pipeline)', () => {
  let mockRouter: { parseUrl: jasmine.Spy };

  // Internal subjects exposed for the test driver. The guard only ever sees
  // the .asObservable() face of these.
  type AuthMock = Pick<AuthService, 'tokenValue' | 'ready$' | 'user$'> & {
    __ready: BehaviorSubject<boolean>;
    __user: BehaviorSubject<AuthUser | null>;
  };

  function buildAuth(opts: { token?: string | null; ready?: boolean } = {}): AuthMock {
    const readySub = new BehaviorSubject<boolean>(opts.ready ?? false);
    const userSub = new BehaviorSubject<AuthUser | null>(null);
    return {
      tokenValue: opts.token === undefined ? 'jwt-test' : opts.token,
      ready$: readySub.asObservable(),
      user$: userSub.asObservable(),
      __ready: readySub,
      __user: userSub
    };
  }

  beforeEach(() => {
    mockRouter = {
      parseUrl: jasmine.createSpy('parseUrl').and.callFake(
        (url: string): UrlTree => ({ parsedUrl: url } as unknown as UrlTree)
      )
    };
  });

  function setup(auth: Partial<AuthService>): Observable<boolean | UrlTree> {
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: mockRouter }
      ]
    });
    // adminGuard's declared return type is `CanActivateFn`, which TS widens
    // to `MaybeAsync<GuardResult>`. At runtime the implementation only ever
    // returns an Observable (or in the no-token branch a synchronous
    // UrlTree). Narrow here so firstValueFrom calls downstream accept it.
    return TestBed.runInInjectionContext(
      () => adminGuard({} as any, {} as any)
    ) as Observable<boolean | UrlTree>;
  }

  it('redirects to /login immediately when there is no token', async () => {
    const auth = buildAuth({ token: null });
    const result = await firstValueFrom(setup(auth));
    expect(result).toEqual(jasmine.objectContaining({ parsedUrl: '/login' }));
    // Critical: the guard must NOT subscribe to ready$/user$ when there is
    // no token, otherwise the auth service would be poked on /login visits
    // before the user has authenticated.
    expect(auth.__ready.observed).toBe(false);
    expect(auth.__user.observed).toBe(false);
  });

  it('does not subscribe to user$ until ready$ resolves', () => {
    const auth = buildAuth({ ready: false });
    const guard$ = setup(auth);
    // The guard returns a cold Observable; subscription only happens when the
    // router runs the guard, so drive it explicitly here.
    const subscription = guard$.subscribe();
    expect(auth.__ready.observed).toBe(true);
    expect(auth.__user.observed).toBe(false);
    subscription.unsubscribe();
  });

  it('allows admins through after ready$ resolves and user$ emits admin', async () => {
    const auth = buildAuth({ ready: false });
    const guard$ = setup(auth);

    auth.__user.next({
      id: 1,
      email: 'admin@nomos.ai',
      role: 'admin',
      subscription_tier: 'enterprise'
    });
    auth.__ready.next(true);

    await expectAsync(firstValueFrom(guard$)).toBeResolvedTo(true);
    expect(mockRouter.parseUrl).not.toHaveBeenCalledWith('/chat');
  });

  it('redirects to /chat when role is anything but admin', async () => {
    const auth = buildAuth({ ready: false });
    const guard$ = setup(auth);

    auth.__user.next({
      id: 2,
      email: 'user@nomos.ai',
      role: 'user',
      subscription_tier: 'basic'
    });
    auth.__ready.next(true);

    const result = await firstValueFrom(guard$);
    expect(result).toEqual(jasmine.objectContaining({ parsedUrl: '/chat' }));
  });

  it('reads the LATEST user$ value once ready$ resolves (no stale cache)', async () => {
    // Reproduces the cold-start race: cached role lands first as 'user'
    // (from localStorage), then /me resolves and overwrites with 'admin'.
    // The guard must yield admin (true) not the stale user → /chat.
    const auth = buildAuth({ ready: false });
    const guard$ = setup(auth);

    auth.__user.next({
      id: 1,
      email: 'admin@nomos.ai',
      role: 'user',
      subscription_tier: 'basic'
    });
    auth.__user.next({
      id: 1,
      email: 'admin@nomos.ai',
      role: 'admin',
      subscription_tier: 'enterprise'
    });
    auth.__ready.next(true);

    const result = await firstValueFrom(guard$);
    expect(result).toBe(true);
  });

  it('redirects to /login when ready$ resolves but user$ only ever emits null', async () => {
    // /me can return 401 (forced logout) before any user is ever set.
    const auth = buildAuth({ ready: false });
    const guard$ = setup(auth);

    // ready fires but no user was set (auth service cleared it on 401).
    auth.__ready.next(true);

    const result = await firstValueFrom(guard$);
    expect(result).toEqual(jasmine.objectContaining({ parsedUrl: '/login' }));
  });
});
