import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, authErrorMessage } from '../../services/auth.service';

@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [CommonModule, RouterLink, TranslatePipe],
  // Inline template (the copy depends on ?type=change) — all chrome lives in
  // src/styles.scss via legacy-name aliases, so no per-component CSS.
  template: `
    <div class="verify-container">
      <div class="verify-box">
        <h2>{{ 'auth.verify.title' | translate }}</h2>
        <p *ngIf="!finished">{{ (isEmailChange ? 'auth.verify.changeWaiting' : 'auth.verify.waiting') | translate }}</p>
        <div *ngIf="finished && success" class="success-msg">
          {{ (isEmailChange ? 'auth.verify.changeSuccess' : 'auth.verify.success') | translate }}
        </div>
        <div *ngIf="finished && !success" class="error-msg">{{ error }}</div>
        <p *ngIf="finished && !success" class="footer-link">
          <a routerLink="/login">{{ 'common.backToSignIn' | translate }}</a>
        </p>
      </div>
    </div>
  `,
  styles: []
})
export class VerifyEmailComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  finished = false;
  success = false;
  error = '';
  /** True when the link came from the change-email flow (`?type=change`). */
  isEmailChange = false;

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  async ngOnInit() {
    // ActivatedRoute.snapshot is fine for a one-shot token/type read.
    const params = this.route.snapshot.queryParamMap;
    const token = params.get('token');
    this.isEmailChange = params.get('type') === 'change';

    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      this.finished = true;
      this.success = false;
      this.error = this.translate.instant(
        this.isEmailChange ? 'auth.verify.changeInvalid' : 'auth.verify.invalid'
      );
      return;
    }

    const result = this.isEmailChange
      ? await this.authService.verifyEmailChange(token)
      : await this.authService.verifyEmail(token);

    this.finished = true;
    if (result.ok) {
      this.success = true;
      // AuthService has already swapped the rotated JWT into localStorage
      // + tokenSubject/userSubject. Move to /chat after a brief pause so
      // the success message reads before navigation.
      setTimeout(() => this.router.navigate(['/chat']), 600);
    } else {
      this.success = false;
      // The backend's `code` picks the translated copy (e.g.
      // `invalid_token` → auth.errors.invalidToken); the raw English
      // server prose is never shown to the user.
      this.error = authErrorMessage(this.translate, result);
    }
  }
}
