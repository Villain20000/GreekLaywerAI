import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';

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
   * surfaces the canonical error message "Email not verified. Check
   * your inbox for the verification link."; LoginComponent pattern-
   * matches that string to expose a Resend-verification affordance.
   */
  verified_at?: string | null;
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
  | { ok: false; error: string; status: number };

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

  /** Phase 25 (admin bypass): banner TTL in ms (30s). Matches admin.component's auto-dismiss. */
  private static readonly MAGIC_LINK_BANNER_DELAY_MS = 30_000;

  private apiUrl = `${environment.apiBaseUrl}/api/auth`;
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
      const response = await fetch(`${this.apiUrl}/me`, {
        method: 'GET',
        headers: this.tokenValue
          ? { Authorization: `Bearer ${this.tokenValue}` }
          : {}
      });
      if (response.status === 401) {
        // Token is invalid/expired — force a fresh login.
        this.logout();
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

  async login(
    email: string,
    password: string
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        /**
         * Discriminated error kinds so the LoginComponent can branch on
         * `kind === 'unverified'` to surface a Resend-verification
         * affordance without leaking whether the email exists.
         */
        kind: 'invalid_credentials' | 'unverified' | 'network' | 'server';
        error: string;
        status: number;
      }
  > {
    try {
      const response = await fetch(`${this.apiUrl}/login`, {
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

      // Phase 24: the server's "Email not verified" message is the cue
      // to switch the LoginComponent into Resend-verification mode. We
      // match on the canonical copy in auth.js. Bumping the message
      // string requires bumping this discriminant too.
      if (response.status === 400 &&
          typeof data?.error === 'string' &&
          data.error.startsWith('Email not verified')) {
        return {
          ok: false,
          kind: 'unverified',
          error: data.error,
          status: response.status
        };
      }
      if (response.status === 400) {
        return {
          ok: false,
          kind: 'invalid_credentials',
          error: data?.error || 'Invalid credentials',
          status: response.status
        };
      }
      return {
        ok: false,
        kind: 'server',
        error: data?.error || `Login failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error) {
      console.error('Login error', error);
      return {
        ok: false,
        kind: 'network',
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
      const response = await fetch(`${this.apiUrl}/register`, {
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

      return {
        ok: false,
        error: data?.error || `Registration failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Register error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
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
  async verifyEmail(
    token: string
  ): Promise<
    | { ok: true; token: string; user: AuthUser }
    | { ok: false; error: string; status: number }
  > {
    try {
      const response = await fetch(`${this.apiUrl}/verify-email`, {
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

      return {
        ok: false,
        error: data?.error || `Verify-email failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Verify-email error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
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
  async verifyMagicLink(
    token: string
  ): Promise<
    | { ok: true; token: string; user: AuthUser }
    | { ok: false; error: string; status: number }
  > {
    try {
      const response = await fetch(`${this.apiUrl}/admin-magic-link/redeem`, {
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

      return {
        ok: false,
        error: data?.error || `Magic-link redeem failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Magic-link redeem error', error);
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: message, status: 0 };
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
  async resendVerification(
    email: string
  ): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    try {
      const response = await fetch(`${this.apiUrl}/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        return { ok: true };
      }

      return {
        ok: false,
        error: data?.error || `Resend-verification failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Resend-verification error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
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
   * Rotate the authenticated user's own password. JWT is required (the
   * interceptor attaches it automatically). Returns the same discriminated
   * shape as register() so callers can surface server errors verbatim
   * without throwing.
   */
  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    try {
      const response = await fetch(`${this.apiUrl}/change-password`, {
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

      // 401 = expired/invalid token. Force re-auth.
      if (response.status === 401) {
        this.logout();
      }

      return {
        ok: false,
        error: data?.error || `Change-password failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Change-password error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
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
  async forgotPassword(
    email: string
  ): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
    try {
      const response = await fetch(`${this.apiUrl}/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        // Always 200; the server hides existence. Show a generic message.
        return { ok: true };
      }

      return {
        ok: false,
        error: data?.error || `Forgot-password failed (HTTP ${response.status})`,
        status: response.status
      };
    } catch (error: unknown) {
      console.error('Forgot-password error', error);
      const message =
        error instanceof Error ? error.message : 'Network error';
      return {
        ok: false,
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
   * reset link") is safe to surface verbatim.
   */
  async resetPassword(
    token: string,
    newPassword: string
  ): Promise<
    | { ok: true; token: string; user: AuthUser }
    | { ok: false; error: string; status: number }
  > {
    try {
      const response = await fetch(`${this.apiUrl}/reset-password`, {
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

      // 401 is unexpected on this route (no JWT) but defensively clear
      // local state to avoid leaving the user with a stale credential.
      if (response.status === 401) {
        this.logout();
      }

      return {
        ok: false,
        error: data?.error || `Reset-password failed (HTTP ${response.status})`,
        status: response.status
      };    } catch (error: unknown) {
      console.error('Reset-password error', error);
      const message = error instanceof Error ? error.message : 'Network error';
      return { ok: false, error: message, status: 0 };
    }
  }

  /**
   * Phase 26: GDPR data export. Returns the raw server payload
   * (profile + conversations + messages + documents) for the caller to
   * serialize into a downloadable file.
   */
  async exportData(): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}/export`, {
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
   * all associated data. Clears local auth state on success.
   */
  async deleteAccount(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/delete-account`, {
      method: 'DELETE',
      headers: this.tokenValue
        ? { Authorization: `Bearer ${this.tokenValue}` }
        : {}
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
