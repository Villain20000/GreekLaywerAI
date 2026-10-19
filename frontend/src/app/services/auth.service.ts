import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Router } from '@angular/router';
import type { TranslateService } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface AuthUser {
  id: number;
  email: string;
  role: 'user' | 'admin' | 'enterprise';
  subscription_tier: 'basic' | 'pro' | 'enterprise';
  /**
   * Phase 22: server-side counter, bumped on /change-password. Optional so
   * legacy cached users (without the field) keep working. The backend
   * authMiddleware rejects any JWT whose tv claim is below the live DB
   * value, so it's the source of truth for "this user has re-logged since
   * the last password rotation".
   */
  token_version?: number;
  /**
   * Phase 24: server-stamped ISO datetime when the user verified their
   * email. `null` = unverified (cannot receive a JWT). The backend
   * /api/auth/login refuses to mint a JWT for unverified accounts and
   * answers with the stable code `unverified_email`; LoginComponent
   * branches on that code (never on the English prose) to expose a
   * Resend-verification affordance.
   */
  verified_at?: string | null;
}

/**
 * Machine-readable error codes returned by the backend on every /api/auth
 * failure. Mirrors the frozen vocabulary in
 * `backend/src/constants/authErrors.js`.
 *
 * The backend keeps its human-readable `error` strings BYTE-FOR-BYTE
 * unchanged — `code` is purely additive — so a client that ignores `code`
 * sees exactly what it saw before. The client, however, must branch on
 * `code`: pattern-matching English prose silently breaks the moment the
 * server rewords a message.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'unverified_email'
  | 'email_taken'
  | 'admin_registration_forbidden'
  | 'invalid_token'
  | 'invalid_request'
  | 'password_change_failed'
  | 'user_not_found'
  | 'admin_role_required'
  | 'not_found'
  | 'request_accepted'
  | 'server_error';

/**
 * Discriminated failure kind carried by every non-OK auth result.
 *
 * This is the SAME mechanism the service already used for /login, widened
 * to the whole auth surface: `kind` is what the components branch on (the
 * login template gates the "Forgot it?" link on
 * `kind === 'invalid_credentials'`, the login component opens the
 * resend-verification panel on `kind === 'unverified'`), while `code`
 * carries the verbatim backend vocabulary for callers that need the exact
 * reason.
 *
 *   - `unverified` is the client-facing name of the backend's
 *     `unverified_email` code (the one that drives the resend affordance).
 *   - `network` is the client-only kind for a request that never reached
 *     the server; it has no backend code.
 *   - `rate_limited` is derived from the HTTP STATUS (429), never from the
 *     body: the backend's rate limiter answers
 *     `{ error: 'Too many requests, please try again later.' }` — no
 *     `code` at all — so a code-less 429 used to fall through to the
 *     generic `server` bucket and the user was told "Server error." for
 *     what is a trivially-triggered per-IP rate limit.
 */
export type AuthErrorKind =
  | 'invalid_credentials'
  | 'unverified'
  | 'email_taken'
  | 'admin_registration_forbidden'
  | 'invalid_token'
  | 'invalid_request'
  | 'password_change_failed'
  | 'user_not_found'
  | 'admin_role_required'
  | 'not_found'
  | 'request_accepted'
  | 'network'
  | 'rate_limited'
  | 'server';

/** Backend code → client-facing kind. */
export const AUTH_ERROR_CODE_TO_KIND: Readonly<
  Record<AuthErrorCode, AuthErrorKind>
> = Object.freeze({
  invalid_credentials: 'invalid_credentials',
  unverified_email: 'unverified',
  email_taken: 'email_taken',
  admin_registration_forbidden: 'admin_registration_forbidden',
  invalid_token: 'invalid_token',
  invalid_request: 'invalid_request',
  password_change_failed: 'password_change_failed',
  user_not_found: 'user_not_found',
  admin_role_required: 'admin_role_required',
  not_found: 'not_found',
  request_accepted: 'request_accepted',
  server_error: 'server'
});

/**
 * Backend code → i18n key. The `auth.errors.*` entries already exist in
 * `assets/i18n/{el,en}.json` (key-identical in both dictionaries).
 */
export const AUTH_ERROR_I18N_KEYS: Readonly<
  Partial<Record<AuthErrorCode, string>>
> = Object.freeze({
  invalid_credentials: 'auth.errors.invalidCredentials',
  unverified_email: 'auth.errors.unverifiedEmail',
  email_taken: 'auth.errors.emailTaken',
  admin_registration_forbidden: 'auth.errors.adminRegistrationForbidden',
  invalid_token: 'auth.errors.invalidToken',
  invalid_request: 'auth.errors.invalidRequest',
  password_change_failed: 'auth.errors.passwordChangeFailed',
  user_not_found: 'auth.errors.userNotFound',
  admin_role_required: 'auth.errors.adminRoleRequired',
  not_found: 'auth.errors.notFound',
  request_accepted: 'auth.errors.requestAccepted',
  server_error: 'auth.errors.serverError'
});

/**
 * Client-facing kind → i18n key. Used as the second step of
 * `authErrorMessage()` for servers that answer without a `code`.
 *
 * `rate_limited` deliberately points at `common.tooManyRequests` (a shared
 * key that already exists in both dictionaries) instead of an
 * `auth.errors.*` entry: the rate limit is not an auth-domain error, it
 * is a transport-level throttle that the whole app can hit.
 */
export const AUTH_ERROR_KIND_I18N_KEYS: Readonly<
  Record<AuthErrorKind, string>
> = Object.freeze({
  invalid_credentials: 'auth.errors.invalidCredentials',
  unverified: 'auth.errors.unverifiedEmail',
  email_taken: 'auth.errors.emailTaken',
  admin_registration_forbidden: 'auth.errors.adminRegistrationForbidden',
  invalid_token: 'auth.errors.invalidToken',
  invalid_request: 'auth.errors.invalidRequest',
  password_change_failed: 'auth.errors.passwordChangeFailed',
  user_not_found: 'auth.errors.userNotFound',
  admin_role_required: 'auth.errors.adminRoleRequired',
  not_found: 'auth.errors.notFound',
  request_accepted: 'auth.errors.requestAccepted',
  network: 'auth.errors.network',
  rate_limited: 'common.tooManyRequests',
  server: 'auth.errors.serverError'
});

/**
 * The single failure shape every /api/auth call resolves to.
 *
 * `code` is the verbatim backend `code` (null when the server sent none we
 * recognise), `kind` is the discriminated classification the UI branches
 * on, and `error` keeps the server's human-readable message so a client
 * that ignores the other two still has something to show.
 */
export interface AuthFailure {
  ok: false;
  kind: AuthErrorKind;
  code: AuthErrorCode | null;
  error: string;
  status: number;
}

/**
 * Resolve the copy shown to the user for a failed auth call.
 *
 *   1. A rate-limited failure (kind `rate_limited`) → the translated
 *      `common.tooManyRequests` string. The classification comes from the
 *      HTTP status, so it wins over any `code` the body happened to carry:
 *      a 429 is a throttle, not a credential problem.
 *   2. Known backend `code` → the translated `auth.errors.*` string.
 *   3. No usable code → the translated string of the discriminated `kind`
 *      (the service derives it from the HTTP status).
 *   4. Nothing resolvable → the server's raw `error` prose, as a
 *      last-resort fallback, so the user is never left with an empty
 *      message.
 *
 * Keeping the raw prose as the FINAL fallback means a server that invents
 * a new code still produces a readable message instead of a blank panel.
 */
export function authErrorMessage(
  translate: TranslateService,
  failure: {
    code?: AuthErrorCode | null;
    kind?: AuthErrorKind | null;
    error?: string | null;
  }
): string {
  const raw = typeof failure.error === 'string' ? failure.error : '';
  const kindKey = failure.kind ? AUTH_ERROR_KIND_I18N_KEYS[failure.kind] : undefined;
  if (failure.kind === 'rate_limited' && kindKey) {
    const text = translate.instant(kindKey);
    if (typeof text === 'string' && text.length > 0 && text !== kindKey) {
      return text;
    }
    return raw;
  }
  const codeKey = failure.code ? AUTH_ERROR_I18N_KEYS[failure.code] : undefined;
  if (codeKey) {
    const text = translate.instant(codeKey);
    if (typeof text === 'string' && text.length > 0 && text !== codeKey) {
      return text;
    }
    return raw;
  }
  if (kindKey) {
    const text = translate.instant(kindKey);
    if (typeof text === 'string' && text.length > 0 && text !== kindKey) {
      return text;
    }
  }
  return raw;
}

/**
 * Phase 24: discriminated return type for /api/auth/register. `success`
 * means the user row + verification token were created — the JWT is NOT
 * yet minted at this point; the user follows the email link to
 * /api/auth/verify-email, which is the FIRST path that issues a JWT.
 *
 * `requires_verification: true` is the only success variant today; an
 * admin-bypass path that lets an admin pre-verify a user could surface
 * `requires_verification: false` here in the future, after which the
 * RegisterComponent would redirect to /chat instead of showing the
 * "check your inbox" panel.
 */
export type RegisterResult =
  | { ok: true; requires_verification: true; user: AuthUser }
  | AuthFailure;

/**
 * Result of /api/auth/login. The failure branch is discriminated on
 * `kind` (see `AuthErrorKind`) and carries the backend's `code`.
 */
export type LoginResult = { ok: true } | AuthFailure;

/** Result of the one-time-token endpoints (/verify-email, /reset-password,
 *  /admin-magic-link/redeem). */
export type TokenAuthResult =
  | { ok: true; token: string; user: AuthUser }
  | AuthFailure;

/** Result of the "no-content" endpoints (/resend-verification,
 *  /forgot-password, /change-password). */
export type SimpleAuthResult = { ok: true } | AuthFailure;

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  /**
   * Phase 25 (admin bypass): sessionStorage key for the "Signed in via
   * magic link" banner flag, consumed-once by AdminComponent on first
   * render. sessionStorage (not localStorage) is deliberate: closing the
   * tab is a natural upper bound on the banner's lifetime so a hand-off
   * to /login never accidentally leaks the signal.
   */
  private static readonly MAGIC_LINK_BANNER_KEY = 'nomos_magic_link_banner';
  private static activeInstance: AuthService | null = null;
  private static authExpiredHandlerInstalled = false;

  /** Phase 25 (admin bypass): banner TTL in ms (30s). Matches admin.component's auto-dismiss. */
  private static readonly MAGIC_LINK_BANNER_DELAY_MS = 30_000;

  private apiUrl = `${environment.apiBaseUrl}/api/auth`;
  // Phase 26: GDPR endpoints live under /api/gdpr (not /api/auth). The
  // previous /api/auth/export + /api/auth/delete-account calls 404'd.
  private gdprUrl = `${environment.apiBaseUrl}/api/gdpr`;
  private tokenSubject: BehaviorSubject<string | null>;
  private userSubject: BehaviorSubject<AuthUser | null>;
  private readySubject: BehaviorSubject<boolean>;
  public token$: Observable<string | null>;
  public user$: Observable<AuthUser | null>;
  /**
   * Emits `true` once the cold-start /me refresh round-trip has settled
   * (success, auth-error, or transient network failure). Sequenced before
   * `user$` by any consumer that wants the authoritative server-side role
   * rather than the cached one (e.g. `adminGuard`).
   */
  public ready$: Observable<boolean>;

  constructor(private router: Router) {
    AuthService.activeInstance = this;
    if (typeof window !== 'undefined' && !AuthService.authExpiredHandlerInstalled) {
      window.addEventListener('nomos:auth-expired', () => {
        AuthService.activeInstance?.logout();
      });
      AuthService.authExpiredHandlerInstalled = true;
    }

    const token = localStorage.getItem('nomos_token');
    const userJson = localStorage.getItem('nomos_user');
    this.tokenSubject = new BehaviorSubject<string | null>(token);
    this.userSubject = new BehaviorSubject<AuthUser | null>(
      userJson ? (JSON.parse(userJson) as AuthUser) : null
    );
    this.readySubject = new BehaviorSubject<boolean>(false);
    this.token$ = this.tokenSubject.asObservable();
    this.user$ = this.userSubject.asObservable();
    this.ready$ = this.readySubject.asObservable();

    // If we have a token but haven't fetched the authoritative user from the
    // server yet, do so now. This avoids stale role/tier in the UI when an
    // admin promotes you in another session and you reload the SPA.
    // The cached user stays as the immediate optimistic value so guards
    // resolve synchronously; if /me fails (401, network, etc.) we clear
    // local storage so the user is forced back through /login.
    if (token) {
      this.refreshFromServer();
    } else {
      // No token => no refresh to wait on. Mark cold-start complete
      // immediately so any `ready$.take(1)` subscriber unblocks.
      this.readySubject.next(true);
    }
  }

  private async refreshFromServer(): Promise<void> {
    try {
      const response = await apiFetch(`${this.apiUrl}/me`, {
        method: 'GET',
        headers: this.tokenValue
          ? { Authorization: `Bearer ${this.tokenValue}` }
          : {}
      });
      if (response.status === 401) {
        // apiFetch already notifies the active session handler.
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      if (data && data.user) {
        localStorage.setItem('nomos_user', JSON.stringify(data.user));
        this.userSubject.next(data.user);
      }
    } catch {
      // Silent: cached user stays in place; user can keep working.
    } finally {
      // Cold-start is over regardless of /me result. Consumers that gate on
      // `ready$` will unblock and read whatever user$ now holds (cached
      // value if /me failed, fresh value if it succeeded, or null if 401
      // forced a logout above).
      this.readySubject.next(true);
    }
  }

  public get tokenValue(): string | null {
    return this.tokenSubject.value;
  }

  public get userValue(): AuthUser | null {
    return this.userSubject.value;
  }

  public get role(): AuthUser['role'] | null {
    return this.userSubject.value?.role ?? null;
  }

  public get isAdmin(): boolean {
    return this.role === 'admin';
  }

  /**
   * Re-fetch /me and update user$ + localStorage. Used after out-of-band
   * account changes: a checkout return (tier flip via webhook/lock
   * completion) or an admin role PATCH in another tab.
   */
  public async refreshUser(): Promise<void> {
    await this.refreshFromServer();
  }

  /**
   * Read the machine-readable `code` the backend attaches to every
   * /api/auth failure. Codes outside the known vocabulary come back as
   * null so the caller can fall back to the human-readable `error`.
   */
  private readErrorCode(data: unknown): AuthErrorCode | null {
    const raw = (data as { code?: unknown } | null | undefined)?.code;
    return typeof raw === 'string' &&
      Object.prototype.hasOwnProperty.call(AUTH_ERROR_CODE_TO_KIND, raw)
      ? (raw as AuthErrorCode)
      : null;
  }

  /**
   * Build the discriminated failure for a non-OK auth response.
   *
   * The `code` (when the server sent a known one) decides the `kind`;
   * otherwise the kind falls back to the HTTP status (429 → 'rate_limited',
   * 5xx → 'server', 4xx → 'invalid_request') or to the caller's explicit
   * fallback. The server's human-readable `error` string is preserved
   * verbatim so a client that ignores `code`/`kind` still has something to
   * show.
   *
   * A 429 is classified by STATUS, before the body is even considered: the
   * backend's rate limiter sends no `code` at all, and the auth endpoints
   * (/login, /register, /resend-verification) all sit behind it. Without
   * this the user would be told "Server error." for a rate limit — and a
   * code-less 400 would silently land in the same bucket.
   */
  private failure(
    data: unknown,
    status: number,
    fallbackError: string,
    fallbackKind?: AuthErrorKind
  ): AuthFailure {
    const code = this.readErrorCode(data);
    const kind: AuthErrorKind = status === 429
      ? 'rate_limited'
      : code
        ? AUTH_ERROR_CODE_TO_KIND[code]
        : fallbackKind ??
          (status >= 500
            ? 'server'
            : status === 0
              ? 'network'
              : 'invalid_request');
    const raw = (data as { error?: unknown } | null | undefined)?.error;
    return {
      ok: false,
      kind,
      code,
      error:
        typeof raw === 'string' && raw.length > 0 ? raw : fallbackError,
      status
    };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.token) {
        localStorage.setItem('nomos_token', data.token);
        if (data.user) {
          localStorage.setItem('nomos_user', JSON.stringify(data.user));
          this.userSubject.next(data.user);
        }
        this.tokenSubject.next(data.token);
        return { ok: true };
      }

      // The backend attaches a stable, machine-readable `code` to every
      // auth failure. Branch on THAT — never on the English prose — so a
      // rewording of the server copy cannot silently change the client's
      // behaviour.
      const code = this.readErrorCode(data);

      // `unverified_email` is the cue for the LoginComponent to switch
      // into Resend-verification mode.
      if (code === 'unverified_email') {
        return {
          ok: false,
          kind: 'unverified',
          code,
          error:
            data?.error ||
            'Email not verified. Check your inbox for the verification link.',
          status: response.status
        };
      }

      // Defensive fallback for a backend that predates the `code` field.
      // The prose compared against here is byte-for-byte what the server
      // used to send, so this cannot change behaviour (the server now
      // always answers `code: 'unverified_email'` for this branch); it
      // only keeps an older deployment from losing the resend affordance.
      if (
        code === null &&
        response.status === 400 &&
        typeof data?.error === 'string' &&
        data.error.startsWith('Email not verified')
      ) {
        return {
          ok: false,
          kind: 'unverified',
          code: null,
          error: data.error,
          status: response.status
        };
      }

      return this.failure(
        data,
        response.status,
        // Legacy fallback strings, byte-for-byte what this service used
        // to return when the server sent no message.
        response.status === 400
          ? 'Invalid credentials'
          : `Login failed (HTTP ${response.status})`,
        // Legacy status-based fallback for a server that sends no code:
        // 400 was the historical "bad credentials" answer. A 429 never
        // reaches this branch — `failure()` classifies it by status as
        // 'rate_limited' (the backend rate-limits /login at 10/min per IP
        // and sends a code-less body).
        response.status === 400 ? 'invalid_credentials' : 'server'
      );
    } catch (error) {
      console.error('Login error', error);
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: error instanceof Error ? error.message : 'Network error',
        status: 0
      };
    }
  }

  /**
   * Phase 24: Register a new user.
   *
   * Server forces role='user' regardless of any client-supplied role value,
   * rejects admin self-promotion with 403, AND no longer mints a JWT.
   * The success path now returns `{ ok: true, requires_verification: true,
   * user: {...unverified...} }` and the caller must display the
   * "Check your email" UX. The actual JWT comes from /api/auth/verify-email
   * after the user clicks the link in the email.
   *
   * Legacy behavior (auto-redirect to /chat after register) is gone — a
   * `requires_verification: true` guard in RegisterComponent shows the
   * panel instead of routing. The discriminated `RegisterResult` return
   * echoes that.
   */
  async register(
    email: string,
    password: string
  ): Promise<RegisterResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json().catch(() => ({}));

      // Phase 24: success is signaled by `requires_verification: true` +
      // a sanitized user object (no `token` field). We do NOT touch
      // localStorage or BehaviorSubjects here — the user is unauthed
      // until /verify-email returns a JWT.
      if (response.ok && data && data.requires_verification && data.user) {
        return {
          ok: true,
          requires_verification: true,
          user: data.user as AuthUser
        };
      }

      return this.failure(
        data,
        response.status,
        `Registration failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Register error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 24: Verify-email.
   *
   * Consumes a one-time verification token from the email link. On
   * success, server returns a fresh JWT AND pushes the user into the
   * authenticated state (localStorage + BehaviorSubjects). Subsequent
   * /api/auth/me calls will return the verified_at timestamp. Mirrors
   * the changePassword/resetPassword swap so the router guards update
   * without a refresh.
   */
  async verifyEmail(token: string): Promise<TokenAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data && data.token) {
        localStorage.setItem('nomos_token', data.token);
        this.tokenSubject.next(data.token);
        if (data.user) {
          localStorage.setItem('nomos_user', JSON.stringify(data.user));
          this.userSubject.next(data.user);
        }
        return { ok: true, token: data.token, user: data.user };
      }

      return this.failure(
        data,
        response.status,
        `Verify-email failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Verify-email error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 25 (admin bypass): redeem an admin-magic-link token.
   *
   * The token comes from a URL printed by the
   * `create-admin-magic-link.js` CLI — operators paste the URL into a
   * browser to land signed in at /admin without typing a password.
   *
   * On success the server bumps `users.token_version` and returns a
   * freshly-minted session JWT + user payload. We swap both into
   * localStorage and BehaviorSubjects so adminGuard picks them up
   * without a hard /me refresh. Response shape intentionally matches
   * verifyEmail/resetPassword so the swap path is shared.
   */
  async verifyMagicLink(token: string): Promise<TokenAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/admin-magic-link/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data && data.token) {
        localStorage.setItem('nomos_token', data.token);
        this.tokenSubject.next(data.token);
        if (data.user) {
          localStorage.setItem('nomos_user', JSON.stringify(data.user));
          this.userSubject.next(data.user);
        }
        // Phase 25 (admin bypass): flag this session so AdminComponent
        // surfaces its "Signed in via magic link" banner on the next
        // render. The flag self-clears after MAGIC_LINK_BANNER_DELAY_MS
        // and is also consumed-once by AdminComponent, so re-entry
        // within the banner window won't re-show it.
        this.setMagicLinkBannerFlag();
        return { ok: true, token: data.token, user: data.user };
      }

      return this.failure(
        data,
        response.status,
        `Magic-link redeem failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Magic-link redeem error', error);
      const message = error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 24: Resend verification email.
   *
   * Returns `{ ok: true }` regardless of whether the email exists or is
   * already verified (the server intentionally suppresses that signal
   * for anti-enumeration). Callers should display a generic
   * "If that email exists, a new verification link has been sent." UX.
   */
  async resendVerification(email: string): Promise<SimpleAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        return { ok: true };
      }

      return this.failure(
        data,
        response.status,
        `Resend-verification failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Resend-verification error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  logout() {
    localStorage.removeItem('nomos_token');
    localStorage.removeItem('nomos_user');
    // Phase 25 (admin bypass): scrub the magic-link banner flag so a
    // hand-off to /login doesn't carry an accidental leftover signal.
    try { sessionStorage.removeItem(AuthService.MAGIC_LINK_BANNER_KEY); } catch (_e) { /* sessionStorage may be unavailable */ }
    this.tokenSubject.next(null);
    this.userSubject.next(null);
    this.router.navigate(['/login']);
  }

  /**
   * Rotate the authenticated user's own password. A JWT is required: the
   * `Authorization: Bearer <token>` header is attached by `apiFetch()`
   * (services/api-client.ts), which injects the stored token whenever the
   * request does not already carry a usable one — there is no HTTP
   * interceptor any more (the old auth interceptor was deleted). This
   * method additionally sets the header explicitly from the in-memory
   * token, so the request still authenticates if localStorage was cleared
   * out from under the running session. Returns the same discriminated
   * shape as register() so callers can surface server errors without
   * throwing.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<SimpleAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.tokenValue
            ? { Authorization: `Bearer ${this.tokenValue}` }
            : {})
        },
        body: JSON.stringify({ currentPassword, newPassword })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        // Phase 22: server rotates token_version on success and returns a
        // freshly minted token signed with the NEW version. Swap the
        // stored credentials here so the next authenticated request uses
        // the new JWT; otherwise the very next call would 401 the user.
        // Any other tab/device still holding the old JWT will hit 401 on
        // its next request and our interceptor will force a /login.
        if (data && data.token) {
          localStorage.setItem('nomos_token', data.token);
          this.tokenSubject.next(data.token);
        }
        if (data && data.user) {
          localStorage.setItem('nomos_user', JSON.stringify(data.user));
          this.userSubject.next(data.user);
        }
        return { ok: true };
      }

      return this.failure(
        data,
        response.status,
        `Change-password failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Change-password error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 23: request a password-reset email.
   *
   * Returns `{ ok: true }` whenever the server returns 2xx (the server
   * intentionally returns 200 even for unknown emails to defeat
   * enumeration). On network error or rare server-side 5xx, returns the
   * standard discriminated shape. The caller shouldn't show the body's
   * `error` field to the user; a generic "If that email exists, a reset
   * link has been sent." is the right UX for both success and 5xx.
   */
  async forgotPassword(email: string): Promise<SimpleAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        // Always 200; the server hides existence. Show a generic message.
        return { ok: true };
      }

      return this.failure(
        data,
        response.status,
        `Forgot-password failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Forgot-password error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 23: consume a password-reset token.
   *
   * On success, the server mints a token whose `tv` matches the user's
   * freshly-bumped `token_version`, so we swap it into localStorage the
   * same way `/change-password` does. The user is then auto-logged in
   * (no second round-trip to /login). On failure we return the standard
   * discriminated shape; the server's 400 message ("Invalid or expired
   * reset link") is surfaced through the translated
   * `auth.errors.invalidToken` copy.
   */
  async resetPassword(
    token: string,
    newPassword: string
  ): Promise<TokenAuthResult> {
    try {
      const response = await apiFetch(`${this.apiUrl}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data && data.token) {
        // Mirror changePassword: push the rotated token through the
        // BehaviorSubjects so the chat header / adminGuard pick up the
        // new credential instantly without a hard /me refresh.
        localStorage.setItem('nomos_token', data.token);
        this.tokenSubject.next(data.token);
        if (data.user) {
          localStorage.setItem('nomos_user', JSON.stringify(data.user));
          this.userSubject.next(data.user);
        }
        return { ok: true, token: data.token, user: data.user };
      }

      return this.failure(
        data,
        response.status,
        `Reset-password failed (HTTP ${response.status})`
      );
    } catch (error: unknown) {
      console.error('Reset-password error', error);
      const message = error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
        kind: 'network',
        code: null,
        error: message,
        status: 0
      };
    }
  }

  /**
   * Phase 26: GDPR data export. Returns the raw server payload
   * (profile + conversations + messages + documents) for the caller to
   * serialize into a downloadable file.
   */
  async exportData(): Promise<unknown> {
    const response = await apiFetch(`${this.gdprUrl}/export`, {
      method: 'GET',
      headers: this.tokenValue
        ? { Authorization: `Bearer ${this.tokenValue}` }
        : {}
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Export failed (HTTP ${response.status})`);
    }
    return data;
  }

  /**
   * Phase 26: GDPR account deletion. Irreversibly wipes the account and
   * all associated data. The backend requires a double opt-out body
   * ({ confirm: true, email }) matching the signed-in account. Clears
   * local auth state on success.
   */
  async deleteAccount(email: string): Promise<void> {
    const response = await apiFetch(`${this.gdprUrl}/account`, {
      method: 'DELETE',
      headers: {
        ...(this.tokenValue ? { Authorization: `Bearer ${this.tokenValue}` } : {}),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ confirm: true, email })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Delete account failed (HTTP ${response.status})`);
    }
    this.logout();
  }

  // ========================================================================
  // Phase 25 (admin bypass): magic-link banner flag helpers.
  //
  // When verifyMagicLink() succeeds it sets a flag in sessionStorage so
  // AdminComponent can render a ~30s dismissable "Signed in via magic link"
  // banner on the next render. The flag:
  //   (a) self-clears after MAGIC_LINK_BANNER_DELAY_MS so an unrendered
  //       flag can't survive past the banner window,
  //   (b) is consumed-and-cleared by consumeMagicLinkBannerFlag() on the
  //       first render so a re-navigation to /admin won't re-show it, and
  //   (c) is wiped by logout() so a sign-out cannot leak the signal.
  //
  // sessionStorage (not localStorage) is deliberate: closing the tab is
  // a natural upper bound on the banner's lifetime, matching the dev-
  // shortcut surgical-use-case.
  // ========================================================================

  /**
   * Stamp the magic-link banner flag. Wrapped in try/catch because
   * sessionStorage can throw in private-mode browsers / SSR / etc.
   */
  private setMagicLinkBannerFlag(): void {
    try {
      sessionStorage.setItem(AuthService.MAGIC_LINK_BANNER_KEY, '1');
      setTimeout(() => {
        try { sessionStorage.removeItem(AuthService.MAGIC_LINK_BANNER_KEY); } catch (_e) { /* swallow */ }
      }, AuthService.MAGIC_LINK_BANNER_DELAY_MS);
    } catch (_e) { /* sessionStorage unavailable — no banner this time */ }
  }

  /**
   * Read-and-clear the magic-link banner flag. Returns true iff the flag
   * was set at the moment of the call. Callers should set their local
   * banner-visible state from this boolean and not re-read; subsequent
   * consume calls return false until verifyMagicLink fires again.
   *
   * The clear happens synchronously here, separate from the self-clear
   * timer in setMagicLinkBannerFlag(), so a re-navigation to /admin
   * within the 30s window does NOT re-show the banner.
   */
  public consumeMagicLinkBannerFlag(): boolean {
    try {
      const present = sessionStorage.getItem(AuthService.MAGIC_LINK_BANNER_KEY) !== null;
      if (present) {
        sessionStorage.removeItem(AuthService.MAGIC_LINK_BANNER_KEY);
      }
      return present;
    } catch (_e) {
      return false;
    }
  }
}
