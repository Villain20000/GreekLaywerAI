import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { BillingService, Subscription, SubscriptionState } from '../../services/billing.service';

@Component({
  selector: 'app-subscriptions',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div class="nl-page-container">
      <h1>Συνδρομή</h1>

      <section class="nl-admin-card">
        <h2>Τρέχουσα συνδρομή</h2>
        <p *ngIf="state">
          Πλάνο: <strong class="nl-role-pill">{{ state.tier }}</strong>
        </p>
        <p *ngIf="state?.subscription?.status" class="nl-prompt-text">
          Κατάσταση: {{ state!.subscription!.status }} ·
          Λήγει: {{ state!.subscription!.current_period_end | date: 'short' }}
        </p>
        <p class="nl-empty-row" *ngIf="!state?.subscription">Καμία ενεργή συνδρομή.</p>
        <div class="nl-form-group">
          <button class="nl-btn-secondary" (click)="cancel()" [disabled]="!state?.subscription || busy">Ακύρωση συνδρομής</button>
          <a class="nl-btn-primary" routerLink="/billing">Αλλαγή πλάνου</a>
        </div>
      </section>

      <section class="nl-admin-card">
        <h2>Ιστορικό</h2>
        <table class="nl-admin-table">
          <thead>
            <tr><th>Κατάσταση</th><th>Περίοδος έως</th><th>Ενεργοποιήθηκε</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let sub of history">
              <td>{{ sub.status }}</td>
              <td>{{ sub.current_period_end | date: 'short' }}</td>
              <td>{{ sub.created_at | date: 'short' }}</td>
            </tr>
            <tr *ngIf="!history.length">
              <td colspan="3" class="nl-empty-row">Κανένα ιστορικό.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      <p class="nl-success-msg" *ngIf="cancelOk">{{ cancelOk }}</p>
    </div>
  `,
  styles: []
})
export class SubscriptionsComponent implements OnInit {
  state: SubscriptionState | null = null;
  history: Subscription[] = [];
  busy = false;
  error = '';
  cancelOk = '';

  constructor(private billingService: BillingService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.state = await this.billingService.getSubscription();
      this.history = await this.billingService.history();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης συνδρομής';
    }
  }

  async cancel(): Promise<void> {
    if (!confirm('Ακύρωση της συνδρομής σας;')) return;
    this.busy = true;
    this.error = '';
    this.cancelOk = '';
    try {
      await this.billingService.cancel();
      this.cancelOk = 'Η συνδρομή σας ακυρώθηκε.';
      this.state = await this.billingService.getSubscription();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία ακύρωσης';
    } finally {
      this.busy = false;
    }
  }
}
