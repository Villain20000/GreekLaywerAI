/**
 * Shared fetch wrapper for services that use the native Fetch API.
 *
 * Angular's HttpInterceptor only applies to HttpClient requests; the app's
 * document, conversation, billing, admin, and AI services use fetch because
 * they also handle multipart uploads and job polling. Keeping auth injection
 * here prevents those services from drifting into unauthenticated requests.
 */
export function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const token = localStorage.getItem('nomos_token');

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
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
