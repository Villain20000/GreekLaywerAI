import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService, AuthUser } from '../../services/auth.service';
import { BillingService, SubscriptionState } from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';
import { QuotaLimit, QuotaService, QuotaUsage } from '../../services/quota.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
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
        <h2>{{ 'profile.usage' | translate }}</h2>
        <p class="nl-error-msg" *ngIf="usageError">{{ usageError }}</p>
        <ng-container *ngIf="usage">
          <p>{{ 'profile.usageAi' | translate }}: {{ usage!.ai.used }} / {{ usageLimit(usage!.ai.limit) }}</p>
          <p>{{ 'profile.usageDocuments' | translate }}: {{ usage!.documents.used }} / {{ usageLimit(usage!.documents.limit) }}</p>
        </ng-container>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'profile.gdpr' | translate }}</h2>
        <div class="nl-form-group">
          <button class="nl-btn-secondary" (click)="exportData()" [disabled]="busy">{{ 'profile.export' | translate }}</button>
          <button class="nl-btn-secondary" (click)="deleteAccount()" [disabled]="busy">{{ 'profile.delete' | translate }}</button>
        </div>
        <p class="nl-prompt-text" *ngIf="busy">{{ 'profile.busy' | translate }}</p>
        <p class="nl-success-msg" *ngIf="downloadOk">{{ downloadOk }}</p>
        <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      </section>
    </div>
  `,
  styles: []
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

  constructor(
    private authService: AuthService,
    private billingService: BillingService,
    private quotaService: QuotaService,
    private router: Router,
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
    try {
      await this.authService.deleteAccount(this.user?.email ?? '');
      this.router.navigate(['/']);
    } catch (err) {
      this.busy = false;
      // The server's English prose is logged, never rendered.
      console.warn('Unable to delete the account', err);
      this.error = this.translate.instant('profile.deleteError');
    }
  }
}
