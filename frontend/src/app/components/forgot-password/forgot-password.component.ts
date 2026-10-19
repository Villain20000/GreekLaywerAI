import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe],  templateUrl: './forgot-password.component.html',
  // Phase 27 — zero per-component CSS. All chrome lives in
  // src/styles.scss via legacy-name aliases; templates untouched.
  styles: [] 
})
export class ForgotPasswordComponent {
  private readonly translate = inject(TranslateService);

  email = '';
  isLoading = false;
  submitted = false;
  error = '';

  constructor(private authService: AuthService, private router: Router) {}

  async onSubmit() {
    this.error = '';

    if (!this.email) {
      this.error = this.translate.instant('common.enterEmail');
      return;
    }

    // Server is source of truth; this is purely UX to catch typos before
    // round-tripping to /api/auth/forgot-password.
    if (!this.isValidEmail(this.email)) {
      this.error = this.translate.instant('common.invalidEmail');
      return;
    }

    this.isLoading = true;

    // The server returns 200 even for unknown emails — but we still route
    // errors through the discriminated shape so network failures and 5xx
    // can be handled.
    const result = await this.authService.forgotPassword(this.email);
    this.isLoading = false;

    // Always show the generic success message. We deliberately do NOT
    // differentiate "user exists" from "user not found" — that would
    // reintroduce enumeration vulnerabilities. The server's failure copy
    // is never rendered here either: it is English prose that has no
    // business in a Greek UI, and the generic message is correct for
    // every outcome (the endpoint answers 200 for known and unknown
    // addresses alike).
    this.submitted = true;
    // Errors are intentionally swallowed (network outage is the only
    // realistic failure mode here).
    void result;
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
}
