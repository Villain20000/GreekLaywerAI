import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],  templateUrl: './login.component.html',
  // Phase 27 — zero per-component CSS. All chrome (page shell, .login-box
  // card, .peek-btn, .primary, .auth-links, fade-in keyframe, .spinner)
  // lives in src/styles.scss via legacy-name aliases. Empty styles array
  // keeps the anyComponentStyle: 4 kB budget untouched.
  styles: [] 
})
export class LoginComponent {
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
   */
  lastFailedKind: 'invalid_credentials' | 'unverified' | 'network' | 'server' | null = null;

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
    if (!this.email || !this.password) {
      this.error = 'Please fill in all fields';
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
      this.router.navigate(['/chat']);
      return;
    }

    // Phase 24: discriminated errors. `unverified` is the only path that
    // surfaces a Resend-verification affordance — the user just needs to
    // click the link in their inbox to activate the account they created.
    // `lastFailedKind` is set in lockstep with `this.error` so the
    // template can branch on kind without string-matching server copy.
    this.error = result.error;
    this.lastFailedKind = result.kind;
    if (result.kind === 'unverified') {
      this.showResend = true;
    }
  }

  async onResend() {
    this.resendMessage = '';
    this.resendIsLoading = true;
    const result = await this.authService.resendVerification(this.email);
    this.resendIsLoading = false;
    if (result.ok) {
      this.resendMessage =
        'If that email is registered and unverified, a new link has been sent. Check your inbox (and spam folder).';
    } else {
      this.resendMessage = result.error;
    }
  }
}
