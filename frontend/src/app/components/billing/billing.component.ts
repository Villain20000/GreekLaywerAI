import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BillingService, SubscriptionState, TierPlan } from '../../services/billing.service';

@Component({
  selector: 'app-billing',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <div class="nl-page-container">
      <h1>{{ 'billing.title' | translate }}</h1>

      <div class="nl-tier-grid">
        <div class="nl-admin-card" *ngFor="let plan of plans">
          <h2>
            {{ plan.name }}
            <span class="nl-role-pill" *ngIf="plan.recommended">{{ 'billing.recommended' | translate }}</span>
            <span class="nl-role-pill" *ngIf="current?.tier === plan.id">{{ 'billing.current' | translate }}</span>
          </h2>
          <p class="nl-landing-hero-subtitle">{{ plan.price }}</p>
          <ul>
            <li *ngFor="let f of plan.features">{{ f }}</li>
          </ul>
          <button
            class="nl-btn-primary"
            [disabled]="busy || current?.tier === plan.id || current?.tier === 'enterprise'"
            (click)="upgrade(plan.id)"
          >
            {{ (current?.tier === plan.id ? 'billing.active' : current?.tier === 'enterprise' ? 'billing.maxPlan' : 'billing.upgrade') | translate }}
          </button>
        </div>
      </div>

      <section class="nl-admin-card nl-billing-manage" *ngIf="current">
        <h2>{{ 'billing.subscription' | translate }}</h2>
        <p class="nl-prompt-text" *ngIf="current.subscription">
          {{ 'billing.status' | translate: { status: current.subscription.status } }}
        </p>
        <p class="nl-empty-row" *ngIf="!current.subscription">
          {{ 'billing.noSubscription' | translate }}
        </p>
        <div class="nl-billing-actions">
          <button
            class="nl-btn-secondary"
            type="button"
            [disabled]="busy || !current.subscription"
            (click)="manageSubscription()"
          >
            {{ 'billing.manage' | translate }}
          </button>
          <button
            *ngIf="canReactivate"
            class="nl-btn-secondary"
            type="button"
            [disabled]="busy"
            (click)="reactivate()"
          >
            {{ 'billing.reactivate' | translate }}
          </button>
        </div>
      </section>

      <p class="nl-prompt-text" *ngIf="plansLoading">{{ 'billing.loadingPlans' | translate }}</p>
      <p class="nl-success-msg" *ngIf="notice">{{ notice }}</p>
      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      <p class="nl-prompt-text" *ngIf="busy">{{ 'billing.redirecting' | translate }}</p>
    </div>
  `,
  styles: [`
    .nl-tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .nl-tier-grid .nl-landing-hero-subtitle { opacity: 1; font-size: 1.15rem; margin: 0.25rem 0 1rem; }
    .nl-billing-manage { margin-top: 1rem; }
    .nl-billing-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 0.75rem; }
  `]
})
export class BillingComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  plans: TierPlan[] = [];
  current: SubscriptionState | null = null;
  plansLoading = false;
  busy = false;
  error = '';
  notice = '';

  constructor(
    private billingService: BillingService,
    private route: ActivatedRoute,
    private router: Router
  ) {}

  get canReactivate(): boolean {
    return this.current?.subscription?.status === 'canceled_at_period_end';
  }

  async ngOnInit(): Promise<void> {
    // Stripe cancel_url lands here with ?checkout=cancelled.
    const checkout = this.route.snapshot.queryParamMap.get('checkout');
    if (checkout) {
      this.notice = checkout === 'cancelled'
        ? this.translate.instant('billing.cancelled')
        : this.translate.instant('billing.completed');
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
    await Promise.all([this.loadSubscription(), this.loadPlans()]);
  }

  private async loadSubscription(): Promise<void> {
    try {
      this.current = await this.billingService.getSubscription();
    } catch (err) {
      // The server's prose is English ("Get subscription failed (HTTP 500)")
      // and the UI is Greek: it is logged, never rendered. The user gets the
      // translated copy for this channel.
      console.warn('Unable to load the subscription', err);
      this.error = this.translate.instant('billing.loadSubscriptionError');
    }
  }

  private async loadPlans(): Promise<void> {
    this.plansLoading = true;
    try {
      this.plans = await this.billingService.getPlans();
    } catch (err) {
      console.warn('Unable to load the plans', err);
      this.error = this.translate.instant('billing.loadPlansError');
    } finally {
      this.plansLoading = false;
    }
  }

  async upgrade(tier: string): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const url = await this.billingService.createCheckoutSession(tier);
      if (url) {
        window.location.href = url;
      } else {
        this.busy = false;
        this.current = await this.billingService.getSubscription();
      }
    } catch (err) {
      this.busy = false;
      console.warn('Unable to start the upgrade', err);
      this.error = this.translate.instant('billing.upgradeError');
    }
  }

  /** Stripe Billing Portal (invoices, payment method, cancellation). */
  async manageSubscription(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const url = await this.billingService.createPortalSession();
      if (url) {
        window.location.href = url;
      }
    } catch (err) {
      console.warn('Unable to open the subscription management', err);
      this.error = this.translate.instant('billing.manageError');
    } finally {
      this.busy = false;
    }
  }

  /** Undo a scheduled cancellation and refresh the visible state. */
  async reactivate(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.notice = '';
    try {
      await this.billingService.reactivate();
      this.current = await this.billingService.getSubscription();
      this.notice = this.translate.instant('billing.reactivatedOk');
    } catch (err) {
      console.warn('Unable to reactivate the subscription', err);
      this.error = this.translate.instant('billing.reactivateError');
    } finally {
      this.busy = false;
    }
  }
}
