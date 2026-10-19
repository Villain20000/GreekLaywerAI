import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthErrorKind, AuthService, authErrorMessage } from '../../services/auth.service';
import { sanitizeReturnUrl } from '../../guards/return-url';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe],  templateUrl: './login.component.html',
  // Phase 27 — zero per-component CSS. All chrome (page shell, .login-box
  // card, .peek-btn, .primary, .auth-links, fade-in keyframe, .spinner)
  // lives in src/styles.scss via legacy-name aliases. Empty styles array
  // keeps the anyComponentStyle: 4 kB budget untouched.
  styles: [] 
})
export class LoginComponent {
  private readonly translate = inject(TranslateService);

  email = '';
  password = '';
  isLoading = false;
  error = '';

  // Phase 24: shown after the server reports the account is unverified.
  // Clicking the button re-issues a verification email (the same
  // /api/auth/resend-verification route RegisterComponent uses).
  showResend = false;
  resendIsLoading = false;
  resendMessage = '';

  // UX: visible peeking of the password before submit. Toggled by the
  // eye-icon button inside .password-row. No security implication
  // because the value never leaves the input control — the user types
  // them in front of the same screen, in the same room.
  showPassword = false;

  /**
   * Discriminator for the inline-link affordance (and any future
   * per-failure-mode chrome). Set inside onSubmit() immediately after
   * writing `this.error`. Reset to null on every fresh submit so a
   * recovered session doesn't keep showing yesterday's failure chrome.
   *
   * Why discriminator instead of string-matching `error === 'Invalid
   * credentials'`: the server reuses that exact string for the
   * "user not found" branch (see /login handler at lines 199–212 of
   * routes/auth.js), so a string-match would silently misfire on the
   * unknown-user branch. A kind-driven gate reads the server's
   * authoritative classification and stays correct if the server copy
   * drifts in future.
   *
   * The kind comes from the backend's machine-readable `code` (see
   * `AuthErrorKind` in services/auth.service.ts) — never from the English
   * prose.
   */
  lastFailedKind: AuthErrorKind | null = null;

  constructor(private authService: AuthService, private router: Router) {}

  /**
   * Toggle the password visibility inline (see showPassword). Pure UI;
   * never sends the value anywhere — the same protection that already
   * hid the password continues to keep it out of the wire.
   */
  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  async onSubmit() {
    // Whitespace-only input is treated as empty so a stray space can't
    // trigger a wasted /login round-trip; the values themselves are sent
    // untrimmed (passwords may legitimately contain spaces).
    if (!this.email.trim() || !this.password.trim()) {
      this.error = this.translate.instant('common.fillAll');
      this.lastFailedKind = null;
      return;
    }

    this.isLoading = true;
    this.error = '';
    this.lastFailedKind = null;
    this.showResend = false;
    this.resendMessage = '';

    const result = await this.authService.login(this.email, this.password);
    this.isLoading = false;

    if (result.ok) {
      // 2-7: honour the target authGuard captured before the sign-in detour.
      // sanitizeReturnUrl() only accepts same-app paths, so a crafted
      // ?returnUrl cannot send the freshly-authenticated user off-site.
      const returnUrl = this.postLoginReturnUrl();
      if (returnUrl) {
        await this.router.navigateByUrl(returnUrl);
      } else {
        await this.router.navigate(['/chat']);
      }
      return;
    }

    // Phase 24: discriminated errors. `unverified` is the only path that
    // surfaces a Resend-verification affordance — the user just needs to
    // click the link in their inbox to activate the account they created.
    // `lastFailedKind` is set in lockstep with `this.error` so the
    // template can branch on kind without string-matching server copy.
    //
    // The message is the TRANSLATED copy picked by the backend's
    // machine-readable `code`; the raw English server prose is never
    // shown to the user.
    this.error = authErrorMessage(this.translate, result);
    this.lastFailedKind = result.kind;
    if (result.kind === 'unverified') {
      this.showResend = true;
    }
  }

  /**
   * Validated `?returnUrl=` target for the current /login URL, or null when
   * absent/invalid. Exposed as a method so the spec can drive the
   * navigation branches without rebuilding the router state.
   */
  postLoginReturnUrl(): string | null {
    // Read from the live router URL rather than a cached snapshot: the
    // login page may be re-entered with different query params (e.g. the
    // guestGuard bounce) without recreating the component.
    const raw = this.router.parseUrl(this.router.url).queryParams['returnUrl'];
    return sanitizeReturnUrl(typeof raw === 'string' ? raw : null);
  }

  async onResend() {
    this.resendMessage = '';
    this.resendIsLoading = true;
    const result = await this.authService.resendVerification(this.email);
    this.resendIsLoading = false;
    if (result.ok) {
      // Anti-enumeration: the server answers identically for known and
      // unknown addresses, so the generic copy is the only safe message.
      this.resendMessage = this.translate.instant('auth.login.resendMessage');
    } else {
      // A failure here is NOT email-specific (network error / 5xx), so the
      // translated failure copy is shown — never the raw English prose.
      this.resendMessage = authErrorMessage(this.translate, result);
    }
  }
}
