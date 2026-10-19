import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { loginRedirectTree } from './return-url';

/**
 * Gate for authenticated pages.
 *
 * Unauthenticated visitors are sent to /login with the URL they were trying
 * to reach captured as `returnUrl` (e.g. /documents?page=2 →
 * /login?returnUrl=%2Fdocuments%3Fpage%3D2). LoginComponent validates and
 * consumes it after a successful sign-in.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.tokenValue) {
    return true;
  }

  return loginRedirectTree(router, state.url);
};
