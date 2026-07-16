import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { MIN_PASSWORD_LENGTH } from '../../shared/auth.constants';

@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],  templateUrl: './reset-password.component.html',
  // Phase 27 — zero per-component CSS. All chrome lives in
  // src/styles.scss via legacy-name aliases; templates untouched.
  styles: [] 
})
export class ResetPasswordComponent implements OnInit {
  // Token from the URL: ?token=<64-hex-chars>
  token: string | null = null;

  newPassword = '';
  confirmPassword = '';
  isLoading = false;
  success = false;
  error = '';

  // Mirrors backend/src/routes/auth.js's MIN_PASSWORD_LENGTH so the UI
  // warning matches the eventual server error.
  readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  ngOnInit() {
    // ActivatedRoute.queryParamMap is observable; for the simple "?token="
    // case a one-shot snapshot read is fine.
    this.token = this.route.snapshot.queryParamMap.get('token');
  }

  async onSubmit() {
    this.error = '';
    this.success = false;

    if (!this.newPassword || !this.confirmPassword) {
      this.error = 'Please fill in all fields';
      return;
    }
    if (this.newPassword.length < this.minPasswordLength) {
      this.error =
        'Password must be at least ' + this.minPasswordLength + ' characters';
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error = 'Passwords do not match';
      return;
    }
    if (!this.token) {
      this.error = 'Missing reset token';
      return;
    }

    this.isLoading = true;

    const result = await this.authService.resetPassword(
      this.token,
      this.newPassword
    );

    this.isLoading = false;

    if (result.ok) {
      this.success = true;
      // Clear the form so a second submit requires deliberate re-entry.
      this.newPassword = '';
      this.confirmPassword = '';
      // Auto-login already happened in the AuthService (the new token +
      // user are in localStorage and BehaviorSubjects). Navigate to /chat.
      setTimeout(() => this.router.navigate(['/chat']), 600);
    } else {
      // Server message ("Invalid or expired reset link") is safe to show.
      this.error = result.error;
    }
  }
}
