import { apiFetch } from './api-client';

/**
 * apiFetch is the replacement for the deleted Angular auth interceptor: it
 * attaches the stored JWT to every native-fetch request and turns a 401 on
 * an authenticated request into the `nomos:auth-expired` event that
 * AuthService.logout() listens for.
 *
 * These specs pin that contract — especially the empty-bearer case, which
 * used to SUPPRESS the localStorage fallback and send a literal
 * `Authorization: Bearer ` to the server.
 */
describe('apiFetch', () => {
  let fetchSpy: jasmine.Spy;
  let dispatchSpy: jasmine.Spy;

  /** Make the stubbed fetch answer with the given HTTP status. */
  const respondWith = (status: number): void => {
    fetchSpy.and.returnValue(
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({})
      } as unknown as Response)
    );
  };

  /** The `Authorization` header of the n-th outgoing request. */
  const sentAuthorization = (call = 0): string | null => {
    const init = fetchSpy.calls.allArgs()[call][1] as RequestInit;
    return (init.headers as Headers).get('Authorization');
  };

  beforeEach(() => {
    localStorage.removeItem('nomos_token');

    fetchSpy = spyOn(globalThis, 'fetch').and.callFake(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({})
      } as unknown as Response)
    );

    // The event is observed on the spy instead of through a real listener:
    // dispatching it for real would log the live AuthService out mid-run
    // (it listens for the very same event), which has nothing to do with
    // what this spec asserts.
    dispatchSpy = spyOn(window, 'dispatchEvent').and.stub();
  });

  afterEach(() => {
    localStorage.removeItem('nomos_token');
  });

  it('attaches the stored JWT as a bearer token', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(200);

    await apiFetch('/api/auth/me');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentAuthorization()).toBe('Bearer jwt-abc');
  });

  it('keeps the other headers of the request intact', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(200);

    await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    const init = fetchSpy.calls.allArgs()[0][1] as RequestInit;
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer jwt-abc');
  });

  it('sends no Authorization header when nothing is stored', async () => {
    respondWith(200);

    await apiFetch('/api/auth/login', { method: 'POST' });

    expect(sentAuthorization()).toBeNull();
  });

  it('replaces an empty "Bearer " header with the stored token', async () => {
    // This is the bug the conversations / billing / document / ai services
    // used to trigger: they build the header themselves as
    // `Bearer ${localStorage.getItem('nomos_token') || ''}`, which is empty
    // when logged out and used to suppress the localStorage fallback.
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(200);

    await apiFetch('/api/conversations', {
      headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
    });

    expect(sentAuthorization()).toBe('Bearer jwt-abc');
  });

  it('drops an empty "Bearer " header entirely when no token is stored', async () => {
    respondWith(200);

    await apiFetch('/api/conversations', {
      headers: { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` }
    });

    // Not "Bearer " — the header is removed rather than sent empty.
    expect(sentAuthorization()).toBeNull();
  });

  it('normalises a bare "Bearer" header (no token at all) as absent', async () => {
    respondWith(200);

    await apiFetch('/api/documents', { headers: { Authorization: 'Bearer' } });

    expect(sentAuthorization()).toBeNull();
  });

  it('leaves a non-empty bearer token supplied by the caller alone', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(200);

    await apiFetch('/api/documents', { headers: { Authorization: 'Bearer caller-token' } });

    expect(sentAuthorization()).toBe('Bearer caller-token');
  });

  it('leaves a non-bearer authorization scheme alone', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(200);

    await apiFetch('/api/documents', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });

    expect(sentAuthorization()).toBe('Basic dXNlcjpwYXNz');
  });

  it('dispatches nomos:auth-expired when an authenticated request is rejected with 401', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(401);

    await apiFetch('/api/auth/me');

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.calls.mostRecent().args[0] as CustomEvent;
    expect(event.type).toBe('nomos:auth-expired');
  });

  it('does NOT dispatch nomos:auth-expired for a 401 without a token', async () => {
    respondWith(401);

    await apiFetch('/api/auth/login', { method: 'POST' });

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch nomos:auth-expired when the token changed in the meantime', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(401);

    // The session was rotated (e.g. by /change-password) while the request
    // was in flight: logging the user out now would kill the NEW session.
    const pending = apiFetch('/api/auth/me');
    localStorage.setItem('nomos_token', 'jwt-xyz');
    await pending;

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch nomos:auth-expired when the token was removed in the meantime', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(401);

    const pending = apiFetch('/api/auth/me');
    localStorage.removeItem('nomos_token');
    await pending;

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does NOT dispatch nomos:auth-expired for a non-401 failure', async () => {
    localStorage.setItem('nomos_token', 'jwt-abc');
    respondWith(500);

    await apiFetch('/api/auth/me');

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('returns the response untouched', async () => {
    respondWith(200);

    const response = await apiFetch('/api/auth/me');

    expect(response.status).toBe(200);
    expect(response.ok).toBeTrue();
  });
});
