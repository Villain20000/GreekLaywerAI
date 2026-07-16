import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],  templateUrl: './register.component.html',
  // Phase 27 — zero per-component CSS. Design-system chrome
  // (.register-container, .register-box, .form-group, .peek-btn,
  // .primary/.secondary buttons, .spinner, .error-msg/.success-msg,
  // .auth-link, .verify-panel, fade-in keyframe) lives in
  // src/styles.scss via legacy-name aliases.
  styles: [] 
})
export class RegisterComponent {
  email = '';
  password = '';
  confirmPassword = '';
  isLoading = false;
  error = '';

  // Phase 24: after a successful register, swap the form for a "check your
  // email" panel rather than redirecting to /chat (no JWT was minted).
  submitted = false;
  submittedEmail = '';
  resendIsLoading = false;
  resendMessage = '';

  // UX: visible peeking of the password fields before submit. Each row has
  // its own toggle so a user can verify either one independently. Same
  // refactor as LoginComponent — pulled from "private to console" into
  // a user-controllable UI affordance.
  showPassword = false;
  showConfirmPassword = false;

  constructor(private authService: AuthService, private router: Router) {}

  togglePasswordVisibility(): void {
    this.showPassword = !this.showPassword;
  }

  toggleConfirmPasswordVisibility(): void {
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  async onSubmit() {
    this.error = '';

    if (!this.email || !this.password || !this.confirmPassword) {
      this.error = 'Please fill in all fields';
      // Reset peek toggles so a fresh attempt starts from a known state.
      this.showPassword = false;
      this.showConfirmPassword = false;
      return;
    }
    if (!this.isValidEmail(this.email)) {
      this.error = 'Please enter a valid email address';
      return;
    }
    if (this.password.length < 8) {
      this.error = 'Password must be at least 8 characters';
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match';
      return;
    }

    this.isLoading = true;
    const result = await this.authService.register(this.email, this.password);
    this.isLoading = false;

    if (result.ok) {
      // Phase 24: requires_verification=true is the only success branch.
      // Show the "Check your email" panel (Resend button + sign-in link)
      // instead of routing to /chat — the user has no JWT yet.
      this.submitted = true;
      this.submittedEmail = this.email;
    } else {
      this.error = result.error;
    }
  }

  /**
   * Phase 24: Resend the verification email. The route is always 200, so
   * we show a generic confirmation regardless of server-side success —
   * server-side, if the email is already verified OR doesn't exist, no
   * email is sent, but the API still returns 200 to defeat enumeration.
   */
  async onResend() {
    this.resendMessage = '';
    this.resendIsLoading = true;
    const result = await this.authService.resendVerification(this.submittedEmail);
    this.resendIsLoading = false;
    if (result.ok) {
      this.resendMessage = 'If that email is registered and unverified, a new link has been sent.';
    } else {
      this.resendMessage = result.error;
    }
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
