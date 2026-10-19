import { Router, UrlTree } from '@angular/router';

/**
 * Where an authenticated user lands when no (valid) returnUrl is present.
 * Kept in one place so authGuard/guestGuard/login stay in sync.
 */
export const DEFAULT_AUTHENTICATED_URL = '/chat';

/**
 * Accept a post-login target only when it is an absolute path inside this
 * app. This is deliberately conservative: anything that could make the
 * browser leave the app (absolute URLs, protocol-relative `//host` URLs,
 * backslash tricks such as `/\host`, control characters) is rejected.
 *
 * Encoded forms are checked too, so `/%2F%2Fevil.example` and
 * `/%5Cevil.example` cannot smuggle an external target past the router.
 * The original (still-encoded) value is returned on success so Angular's
 * Router can decode query params / fragments itself.
 */
export function sanitizeReturnUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();
  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding: do not hand it to the router.
    return null;
  }
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return null;
  }

  // Never bounce an authenticated user back onto the auth pages themselves.
  const path = value.split(/[?#]/, 1)[0];
  if (path === '/login' || path === '/register') {
    return null;
  }

  return value;
}

/**
 * Build the `/login?returnUrl=…` URL for an unauthenticated user. The
 * target is validated first and percent-encoded exactly once.
 */
export function loginRedirectUrl(target: string | null | undefined): string {
  const safeTarget = sanitizeReturnUrl(target);
  return safeTarget
    ? `/login?returnUrl=${encodeURIComponent(safeTarget)}`
    : '/login';
}

export function loginRedirectTree(
  router: Router,
  target: string | null | undefined
): UrlTree {
  return router.parseUrl(loginRedirectUrl(target));
}
