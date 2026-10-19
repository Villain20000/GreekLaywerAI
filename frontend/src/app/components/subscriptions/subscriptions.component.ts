import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BillingService, Subscription, SubscriptionState } from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  selector: 'app-subscriptions',
  standalone: true,
  imports: [CommonModule, RouterLink, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'subscriptions.title' | translate }}</h1>

      <section class="nl-admin-card">
        <h2>{{ 'subscriptions.current' | translate }}</h2>
        <p *ngIf="state">
          {{ 'subscriptions.planLabel' | translate }}: <strong class="nl-role-pill">{{ state.tier }}</strong>
        </p>
        <p *ngIf="state?.subscription?.status" class="nl-prompt-text">
          {{ 'subscriptions.status' | translate: { status: state!.subscription!.status } }} ·
          {{ 'subscriptions.expires' | translate }} {{ state!.subscription!.current_period_end | date: 'short' }}
        </p>
        <p class="nl-empty-row" *ngIf="!state?.subscription">{{ 'subscriptions.none' | translate }}</p>
        <div class="nl-form-group">
          <button class="nl-btn-secondary" (click)="cancel()" [disabled]="!state?.subscription || busy">{{ 'subscriptions.cancel' | translate }}</button>
          <a class="nl-btn-primary" routerLink="/billing">{{ 'subscriptions.changePlan' | translate }}</a>
        </div>
      </section>

      <section class="nl-admin-card">
        <h2>{{ 'subscriptions.history' | translate }}</h2>
        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'subscriptions.historyAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'subscriptions.colStatus' | translate }}</th>
                <th>{{ 'subscriptions.colPeriodEnd' | translate }}</th>
                <th>{{ 'subscriptions.colCreated' | translate }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let sub of history">
                <td>{{ sub.status }}</td>
                <td>{{ sub.current_period_end | date: 'short' }}</td>
                <td>{{ sub.created_at | date: 'short' }}</td>
              </tr>
              <tr *ngIf="!history.length">
                <td colspan="3" class="nl-empty-row">{{ 'subscriptions.historyEmpty' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      <p class="nl-success-msg" *ngIf="cancelOk">{{ cancelOk }}</p>
    </div>
  `,
  styles: []
})
export class SubscriptionsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  state: SubscriptionState | null = null;
  history: Subscription[] = [];
  busy = false;
  error = '';
  cancelOk = '';

  constructor(
    private billingService: BillingService,
    private confirm: ConfirmService
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.state = await this.billingService.getSubscription();
      this.history = await this.billingService.history();
    } catch (err) {
      // The server's prose is English ("Get subscription failed (HTTP 500)")
      // and the UI is Greek: it is logged, never rendered. The user gets the
      // translated copy for this channel.
      console.warn('Unable to load the subscription', err);
      this.error = this.translate.instant('subscriptions.loadError');
    }
  }

  async cancel(): Promise<void> {
    const confirmed = await this.confirm.ask({
      title: this.translate.instant('subscriptions.cancelTitle'),
      message: this.translate.instant('subscriptions.cancelMessage'),
      confirmLabel: this.translate.instant('subscriptions.cancel'),
      cancelLabel: this.translate.instant('subscriptions.cancelBack')
    });
    if (!confirmed) return;
    this.busy = true;
    this.error = '';
    this.cancelOk = '';
    try {
      await this.billingService.cancel();
      this.cancelOk = this.translate.instant('subscriptions.cancelledOk');
      this.state = await this.billingService.getSubscription();
    } catch (err) {
      console.warn('Unable to cancel the subscription', err);
      this.error = this.translate.instant('subscriptions.cancelError');
    } finally {
      this.busy = false;
    }
  }
}
