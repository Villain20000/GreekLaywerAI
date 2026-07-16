import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject, Injector } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * Auth interceptor:
 *   - Attaches `Authorization: Bearer <token>` when a token is present.
 *   - On a downstream 401 response, force a clean /login via AuthService so
 *     a stale token (e.g. one that was rotated away by /change-password on
 *     another tab/device) doesn't strand the user on a broken page with
 *     silent API failures.
 *
 * Phase 22: the strict token_version equality check in authMiddleware will
 * reject older JWTs. Without this global handler, OTHER tabs or devices that
 * still hold an old JWT would get silent 401s with no UI signal. The handler
 * routes them to /login via `AuthService.logout()` (which already navigates).
 *
 * Whitelist note: we only act when a token was attached, so legitimate 401s
 * on /api/auth/login or /api/auth/register from anonymous callers (or rate
 * limiting 429s that never reach here) don't trigger a spurious /login
 * redirect.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.tokenValue;

  const cloned = token
    ? req.clone({ headers: req.headers.set('Authorization', `Bearer ${token}`) })
    : req;

  return next(cloned).pipe(
    catchError((err) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && token) {
        // The token we sent is no longer accepted on the server side. Most
        // common cause: the user rotated the password on /api/auth/change-
        // password (which bumps token_version) on another tab/device; this
        // tab's stored JWT now fails authMiddleware's strict equality check.
        // logout() clears localStorage + BehaviorSubjects + navigates /login.
        authService.logout();
      }
      return throwError(() => err);
    })
  );
};
