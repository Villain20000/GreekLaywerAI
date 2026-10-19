import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { DEFAULT_AUTHENTICATED_URL, sanitizeReturnUrl } from './return-url';

/**
 * Gate for the public auth pages (/login, /register).
 *
 * An already-authenticated visitor should never see a sign-in form again:
 * send them to the (validated) returnUrl they were given, or to the default
 * authenticated destination. Invalid/external returnUrls fall back to
 * /chat, so a crafted `?returnUrl=https://evil.example` cannot redirect
 * off-site.
 */
export const guestGuard: CanActivateFn = (route) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.tokenValue) {
    return true;
  }

  const returnUrl = sanitizeReturnUrl(
    route.queryParamMap.get('returnUrl')
  );

  return router.parseUrl(returnUrl ?? DEFAULT_AUTHENTICATED_URL);
};
