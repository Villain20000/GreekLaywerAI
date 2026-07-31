import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BillingService, SubscriptionState } from '../../services/billing.service';

interface TierPlan {
  id: string;
  name: string;
  price: string;
  features: string[];
  recommended?: boolean;
}

@Component({
  selector: 'app-billing',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="nl-page-container">
      <h1>Πλάνα</h1>

      <div class="nl-tier-grid">
        <div class="nl-admin-card" *ngFor="let plan of plans">
          <h2>
            {{ plan.name }}
            <span class="nl-role-pill" *ngIf="plan.recommended">Συνιστώμενο</span>
            <span class="nl-role-pill" *ngIf="current?.tier === plan.id">Τρέχον</span>
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
            {{ current?.tier === plan.id ? 'Ενεργό' : current?.tier === 'enterprise' ? 'Μέγιστο πλάνο' : 'Αναβάθμιση' }}
          </button>
        </div>
      </div>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      <p class="nl-prompt-text" *ngIf="busy">Ανακατεύθυνση στο ταμείο…</p>
    </div>
  `,
  styles: [`
    .nl-tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
  `]
})
export class BillingComponent {
  plans: TierPlan[] = [
    {
      id: 'basic',
      name: 'Basic',
      price: 'Δωρεάν',
      features: ['20 ερωτήματα AI / ημέρα', 'Έγγραφα: έως 10', 'Αναζήτηση στα έγγραφα']
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '19 € / μήνα',
      recommended: true,
      features: ['60 ερωτήματα AI / ημέρα', 'Απεριόριστα έγγραφα', 'Προτεραιότητα επεξεργασίας']
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      price: '49 € / μήνα',
      features: ['120 ερωτήματα AI / ημέρα', 'Απεριόριστα έγγραφα', 'Υποστήριξη με προτεραιότητα']
    }
  ];

  current: SubscriptionState | null = null;
  busy = false;
  error = '';

  constructor(private billingService: BillingService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.current = await this.billingService.getSubscription();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης συνδρομής';
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
      this.error = err instanceof Error ? err.message : 'Αποτυχία αναβάθμισης';
    }
  }
}
