import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, authErrorMessage } from '../../services/auth.service';
import { MIN_PASSWORD_LENGTH } from '../../shared/auth.constants';

@Component({
  selector: 'app-change-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe],  templateUrl: './change-password.component.html',
  // Phase 27 — zero per-component CSS. All chrome (page shell, card,
  // inputs, peek toggles, primary button, spinner, banners, footer
  // auth-link) is composed from src/styles.scss via legacy-name aliases.
  styles: [] 
})
export class ChangePasswordComponent {
  private readonly translate = inject(TranslateService);

  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  isLoading = false;
  success = false;
  error = '';

  // Password peek toggles — one per row, mirroring the LoginComponent and
  // RegisterComponent polish. Each is independently toggleable so the
  // user can verify whichever field they wish.
  showCurrent = false;
  showNew = false;
  showConfirm = false;

  // Server's MIN_PASSWORD_LENGTH, mirrored in shared/auth.constants.ts.
  // Server is the source of truth; update both sides in lockstep.
  readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  constructor(private authService: AuthService, private router: Router) {}

  toggleCurrent(): void { this.showCurrent = !this.showCurrent; }
  toggleNew(): void     { this.showNew     = !this.showNew; }
  toggleConfirm(): void { this.showConfirm = !this.showConfirm; }

  async onSubmit() {
    this.error = '';
    this.success = false;

    if (!this.currentPassword || !this.newPassword || !this.confirmPassword) {
      this.error = this.translate.instant('common.fillAll');
      // Reset peek toggles so a fresh attempt starts from a known state.
      this.showCurrent = false;
      this.showNew = false;
      this.showConfirm = false;
      return;
    }
    if (this.newPassword.length < this.minPasswordLength) {
      this.error = this.translate.instant('common.passwordMin', {
        min: this.minPasswordLength
      });
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.error = this.translate.instant('auth.change.mismatch');
      return;
    }
    if (this.newPassword === this.currentPassword) {
      this.error = this.translate.instant('auth.change.sameAsCurrent');
      return;
    }

    this.isLoading = true;

    const result = await this.authService.changePassword(
      this.currentPassword,
      this.newPassword
    );

    this.isLoading = false;

    if (result.ok) {
      this.success = true;
      // Clear the form so a second rotation requires deliberate re-entry.
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
    } else {
      // The backend's `code` picks the translated copy (e.g.
      // `password_change_failed` → auth.errors.passwordChangeFailed);
      // the raw English server prose is never shown to the user.
      this.error = authErrorMessage(this.translate, result);
    }
  }
}
