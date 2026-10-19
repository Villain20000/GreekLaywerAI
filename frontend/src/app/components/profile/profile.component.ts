import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, AuthUser, authErrorMessage } from '../../services/auth.service';
import { BillingService, SubscriptionState } from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';
import { QuotaLimit, QuotaService, QuotaUsage } from '../../services/quota.service';

/** Mirrors the server-side shape check on POST /api/auth/change-email. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'profile.title' | translate }}</h1>

      <section class="nl-admin-card">
        <h2>{{ 'profile.account' | translate }}</h2>
        <p *ngIf="user"><strong>{{ user.email }}</strong></p>
        <p>{{ 'profile.planLabel' | translate }}: <span class="nl-role-pill">{{ state?.tier ?? '—' }}</span></p>
        <p *ngIf="state?.subscription?.status" class="nl-prompt-text">
          {{ 'profile.subscriptionStatus' | translate: { status: state!.subscription!.status } }} ·
          {{ 'profile.until' | translate }} {{ state!.subscription!.current_period_end | date: 'short' }}
        </p>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'profile.emailChangeTitle' | translate }}</h2>
        <p class="nl-prompt-text">{{ 'profile.emailChangeHint' | translate }}</p>
        <form (ngSubmit)="submitEmailChange()">
          <div class="nl-form-group">
            <label for="profile-new-email">{{ 'profile.emailChangeNewEmail' | translate }}</label>
            <input
              id="profile-new-email"
              class="nl-input"
              type="email"
              name="newEmail"
              autocomplete="email"
              [(ngModel)]="emailChangeAddress"
              [disabled]="emailChangeBusy"
              [attr.placeholder]="'profile.emailChangeEmailPlaceholder' | translate"
            />
            <label for="profile-email-current-password">{{ 'profile.emailChangeCurrentPassword' | translate }}</label>
            <input
              id="profile-email-current-password"
              class="nl-input"
              type="password"
              name="currentPassword"
              autocomplete="current-password"
              [(ngModel)]="emailChangePassword"
              [disabled]="emailChangeBusy"
            />
          </div>
          <button
            type="submit"
            class="nl-btn-secondary"
            [disabled]="emailChangeBusy"
          >{{ (emailChangeBusy ? 'profile.emailChangeSubmitting' : 'profile.emailChangeSubmit') | translate }}</button>
        </form>
        <p class="nl-success-msg" role="status" *ngIf="emailChangeSuccess">{{ emailChangeSuccess }}</p>
        <p class="nl-error-msg" role="alert" *ngIf="emailChangeError">{{ emailChangeError }}</p>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'profile.usage' | translate }}</h2>
        <p class="nl-error-msg" *ngIf="usageError">{{ usageError }}</p>
        <ng-container *ngIf="usage">
          <p>{{ 'profile.usageAi' | translate }}: {{ usage!.ai.used }} / {{ usageLimit(usage!.ai.limit) }}</p>
          <p>{{ 'profile.usageDocuments' | translate }}: {{ usage!.documents.used }} / {{ usageLimit(usage!.documents.limit) }}</p>
        </ng-container>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'profile.gdpr' | translate }}</h2>
        <div class="nl-warning-panel" role="status" *ngIf="deletionScheduledFor">
          <strong>{{ 'profile.deletionScheduledTitle' | translate }}</strong>
          <p>
            {{ 'profile.deletionScheduledMessage' | translate: { date: (deletionScheduledFor | date: 'short') } }}
          </p>
          <button type="button" class="nl-btn-secondary" (click)="cancelDeletion()" [disabled]="busy">
            {{ 'profile.cancelDeletion' | translate }}
          </button>
        </div>
        <div class="nl-form-group">
          <button class="nl-btn-secondary" (click)="exportData()" [disabled]="busy">{{ 'profile.export' | translate }}</button>
          <button class="nl-btn-secondary" (click)="deleteAccount()" [disabled]="busy">{{ 'profile.delete' | translate }}</button>
        </div>
        <p class="nl-prompt-text" *ngIf="busy">{{ 'profile.busy' | translate }}</p>
        <p class="nl-success-msg" role="status" *ngIf="downloadOk">{{ downloadOk }}</p>
        <p class="nl-success-msg" role="status" *ngIf="deletionSuccess">{{ deletionSuccess }}</p>
        <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      </section>
    </div>
  `,
  styles: [`
    .nl-warning-panel {
      padding: var(--nl-space-3) var(--nl-space-4);
      margin-bottom: var(--nl-space-4);
      border: 1px solid rgba(255, 152, 0, 0.45);
      border-radius: var(--nl-radius-md);
      background: var(--nl-warning-bg);
      color: var(--nl-warning);
    }
    .nl-warning-panel p {
      margin: var(--nl-space-2) 0;
      color: var(--nl-fg);
    }
  `]
})
export class ProfileComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  user: AuthUser | null = null;
  state: SubscriptionState | null = null;
  busy = false;
  error = '';
  downloadOk = '';
  /** Today's quota usage (AI queries + uploaded documents). */
  usage: QuotaUsage | null = null;
  /** Set when the usage endpoint could not be reached; the page still works. */
  usageError = '';

  /** Pending account-deletion deadline (ISO), or null when none is scheduled. */
  deletionScheduledFor: string | null = null;
  /** Confirmation copy after a successful cancellation. */
  deletionSuccess = '';

  /** Email-change form state — its own channel, like the usage one. */
  emailChangeAddress = '';
  emailChangePassword = '';
  emailChangeBusy = false;
  emailChangeError = '';
  emailChangeSuccess = '';

  constructor(
    private authService: AuthService,
    private billingService: BillingService,
    private quotaService: QuotaService,
    private confirm: ConfirmService
  ) {}

  async ngOnInit(): Promise<void> {
    this.user = this.authService.userValue;
    try {
      this.state = await this.billingService.getSubscription();
    } catch (err) {
      // The billing backend's prose is English ("Subscription not found."):
      // log it, show the translated copy for this channel.
      console.warn('Unable to load the subscription state', err);
      this.error = this.translate.instant('profile.loadError');
    }
    await this.loadUsage();
    await this.loadDeletionStatus();
  }

  /**
   * Loads the pending deletion deadline. A failure is logged and leaves the
   * page usable without the cancellation panel.
   */
  private async loadDeletionStatus(): Promise<void> {
    try {
      const status = await this.authService.getDeletionStatus();
      this.deletionScheduledFor = status.deletionScheduledFor;
    } catch (err) {
      console.warn('Unable to load the account deletion status', err);
    }
  }

  /**
   * Loads today's usage. A failure is reported in its own channel: the rest
   * of the profile (plan, GDPR export/delete) must keep working.
   */
  private async loadUsage(): Promise<void> {
    this.usageError = '';
    try {
      this.usage = await this.quotaService.getUsage();
    } catch (err) {
      console.warn('Unable to load quota usage', err);
      this.usage = null;
      this.usageError = this.translate.instant('profile.usageLoadError');
    }
  }

  /**
   * Renders the limit column of the usage rows.
   *
   *   - `null` → the backend's explicit marker for the enterprise tier /
   *     admins: the translated "unlimited" copy.
   *   - a finite number → the cap itself.
   *   - anything else (absent, `undefined`, malformed) → a dash: the
   *     number is UNKNOWN. It must NOT read as "unlimited" — that would be
   *     a reassuring-but-wrong claim.
   */
  usageLimit(limit: QuotaLimit): string {
    if (limit === null) return this.translate.instant('profile.usageUnlimited');
    if (typeof limit === 'number' && Number.isFinite(limit)) return String(limit);
    return '—';
  }

  /**
   * Request an email change. The server mails the new address and keeps
   * users.email as-is until the link is consumed, so success here means
   * "check the new inbox" rather than "your email changed".
   */
  async submitEmailChange(): Promise<void> {
    if (this.emailChangeBusy) return;

    this.emailChangeError = '';
    this.emailChangeSuccess = '';

    const address = this.emailChangeAddress.trim();
    if (!EMAIL_PATTERN.test(address)) {
      this.emailChangeError = this.translate.instant('profile.emailChangeInvalidEmail');
      return;
    }
    if (!this.emailChangePassword) {
      this.emailChangeError = this.translate.instant('profile.emailChangePasswordRequired');
      return;
    }
    if (address.toLowerCase() === (this.user?.email ?? '').trim().toLowerCase()) {
      this.emailChangeError = this.translate.instant('profile.emailChangeSameEmail');
      return;
    }

    this.emailChangeBusy = true;
    const result = await this.authService.changeEmail(address, this.emailChangePassword);
    this.emailChangeBusy = false;

    if (result.ok) {
      this.emailChangeSuccess = this.translate.instant('profile.emailChangeSent');
      this.emailChangeAddress = '';
      this.emailChangePassword = '';
    } else if (result.code === 'password_change_failed') {
      // The generic auth copy for this code says "password change failed";
      // in this form the actionable message is "wrong current password".
      this.emailChangeError = this.translate.instant('profile.emailChangeWrongPassword');
    } else {
      // Branch on the backend `code` via authErrorMessage; the raw English
      // server prose is logged by the service, never rendered.
      this.emailChangeError = authErrorMessage(this.translate, result);
    }
  }

  async exportData(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.downloadOk = '';
    try {
      const data = await this.authService.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nomos-export.json';
      a.click();
      URL.revokeObjectURL(url);
      this.downloadOk = this.translate.instant('profile.exportOk');
    } catch (err) {
      // The server's English prose is logged, never rendered.
      console.warn('Unable to export the account data', err);
      this.error = this.translate.instant('profile.exportError');
    } finally {
      this.busy = false;
    }
  }

  async deleteAccount(): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: this.translate.instant('profile.deleteTitle'),
      message: this.translate.instant('profile.deleteMessage'),
      confirmLabel: this.translate.instant('profile.deleteConfirm'),
      cancelLabel: this.translate.instant('profile.cancel')
    });
    if (!confirmed) return;
    this.busy = true;
    this.error = '';
    this.deletionSuccess = '';
    try {
      const result = await this.authService.deleteAccount(this.user?.email ?? '');
      this.deletionScheduledFor = result.deletionScheduledFor;
    } catch (err) {
      // The server's English prose is logged, never rendered.
      console.warn('Unable to schedule the account deletion', err);
      this.error = this.translate.instant('profile.deleteError');
    } finally {
      this.busy = false;
    }
  }

  async cancelDeletion(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.deletionSuccess = '';
    try {
      await this.authService.cancelAccountDeletion();
      this.deletionScheduledFor = null;
      this.deletionSuccess = this.translate.instant('profile.deletionCancelled');
    } catch (err) {
      console.warn('Unable to cancel the account deletion', err);
      this.error = this.translate.instant('profile.cancelDeletionError');
    } finally {
      this.busy = false;
    }
  }
}
