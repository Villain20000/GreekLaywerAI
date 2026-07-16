import { inject } from '@angular/core';
import { Router, CanActivateFn, UrlTree } from '@angular/router';
import { Observable } from 'rxjs';
import { filter, map, switchMap, take } from 'rxjs/operators';
import { AuthService, AuthUser } from '../services/auth.service';

/**
 * Admin guard: gates the /admin route on a verified `admin` role.
 *
 * Behaviour:
 *   - no token at all             -> redirect to /login (immediate, sync)
 *   - token but user resolved     -> role === admin ? allow : redirect to /chat
 *   - token but user is null      -> redirect to /login (e.g. /me 401 forced
 *                                    AuthService.logout() to clear user$ before
 *                                    `ready$` flipped to true, leaving us with
 *                                    a permanent null user)
 *
 * Implementation note: this guard returns an Observable and sequences
 * `ready$` (cold-start /me settled) then `user$` (take(1) on the current
 * BehaviorSubject value). BehaviorSubject always replays its current value
 * on subscription, so `take(1)` is guaranteed to emit something — null
 * included — which is what lets us handle the post-401 case explicitly here
 * instead of hanging in a forever-blocking filter.
 */
export const adminGuard: CanActivateFn = (
  _route,
  _state
): Observable<boolean | UrlTree> => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // No cached token at all — no point waiting for /me. Send to /login.
  // Wrapped in an inline Observable so the function's static return type
  // is always `Observable<boolean | UrlTree>` — simpler for callers that
  // unconditionally subscribe (including the Jasmine spec helper).
  if (!authService.tokenValue) {
    return new Observable<boolean | UrlTree>((observer) => {
      observer.next(router.parseUrl('/login'));
      observer.complete();
    });
  }

  return authService.ready$.pipe(
    filter((ready): ready is true => ready === true),
    take(1),
    switchMap(() => authService.user$),
    take(1),
    map((user): boolean | UrlTree => {
      // /me 401 (or any path that left user$ at null) — back to /login.
      if (user === null) {
        return router.parseUrl('/login');
      }
      return user.role === 'admin' ? true : router.parseUrl('/chat');
    })
  );
};
