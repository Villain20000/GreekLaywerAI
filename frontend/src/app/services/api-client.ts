/**
 * Shared fetch wrapper for services that use the native Fetch API.
 *
 * Angular's HttpInterceptor only applies to HttpClient requests; the app's
 * document, conversation, billing, admin, and AI services use fetch because
 * they also handle multipart uploads and job polling. Keeping auth injection
 * here prevents those services from drifting into unauthenticated requests.
 */

/**
 * The credential carried by an `Authorization` header, or '' when the
 * header carries none.
 *
 * `'Bearer abc'` → 'abc'; `'Bearer '`, `'Bearer'`, `'  '` and `''` → ''.
 * A non-Bearer scheme (e.g. `'Basic xyz'`) is returned untouched, so a
 * caller that deliberately uses another scheme keeps it.
 */
function credentialOf(authorizationHeader: string): string {
  return authorizationHeader.replace(/^\s*bearer\b\s*/i, '').trim();
}

/**
 * Attach the stored JWT to a request and notify the session when the
 * server rejects it.
 *
 * The `Authorization` header is normalised here, centrally: an existing
 * header whose token part is EMPTY is treated as absent. Several services
 * build their own header as
 * `Bearer ${localStorage.getItem('nomos_token') || ''}`, which — when
 * logged out — produces the literal header `Authorization: Bearer ` and
 * used to SUPPRESS the fallback below, sending an empty bearer to the
 * server (and getting a 401 that no client could interpret). Normalising
 * here fixes every call site at once.
 */
export function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem('nomos_token');

  // An `Authorization` header that carries no credential is equivalent to
  // no header at all: drop it, then let the stored token take over.
  const existing = headers.get('Authorization');
  const hasCredential = existing !== null && credentialOf(existing) !== '';
  if (!hasCredential) {
    headers.delete('Authorization');
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  return fetch(input, { ...init, headers }).then((response) => {
    // Native fetch calls do not pass through Angular's auth interceptor.
    // Notify the live AuthService when an authenticated request is rejected
    // so stale sessions get the same logout behavior everywhere.
    if (
      response.status === 401 &&
      token &&
      typeof window !== 'undefined' &&
      localStorage.getItem('nomos_token') === token
    ) {
      window.dispatchEvent(new CustomEvent('nomos:auth-expired'));
    }
    return response;
  });
}
