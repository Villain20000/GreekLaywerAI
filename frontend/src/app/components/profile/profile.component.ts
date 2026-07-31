import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { BillingService, SubscriptionState } from '../../services/billing.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="nl-page-container">
      <h1>Προφίλ</h1>

      <section class="nl-admin-card">
        <h2>Στοιχεία λογαριασμού</h2>
        <p *ngIf="user"><strong>{{ user.first_name }} {{ user.last_name }}</strong> — {{ user.email }}</p>
        <p>Πλάνο: <span class="nl-role-pill">{{ state?.tier ?? '—' }}</span></p>
        <p *ngIf="state?.subscription?.status" class="nl-prompt-text">
          Συνδρομή: {{ state!.subscription!.status }} · έως {{ state!.subscription!.current_period_end | date: 'short' }}
        </p>
      </section>

      <section class="nl-admin-card">
        <h2>Δεδομένα & GDPR</h2>
        <div class="nl-form-group">
          <button class="nl-btn-secondary" (click)="exportData()" [disabled]="busy">Εξαγωγή δεδομένων</button>
          <button class="nl-btn-secondary" (click)="deleteAccount()" [disabled]="busy">Διαγραφή λογαριασμού</button>
        </div>
        <p class="nl-prompt-text" *ngIf="busy">Παρακαλώ περιμένετε…</p>
        <p class="nl-success-msg" *ngIf="downloadOk">{{ downloadOk }}</p>
        <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      </section>
    </div>
  `,
  styles: []
})
export class ProfileComponent implements OnInit {
  user: { first_name?: string; last_name?: string; email: string } | null = null;
  state: SubscriptionState | null = null;
  busy = false;
  error = '';
  downloadOk = '';

  constructor(
    private authService: AuthService,
    private billingService: BillingService,
    private router: Router
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.user = this.authService.userValue;
      this.state = await this.billingService.getSubscription();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία φόρτωσης προφίλ';
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
      this.downloadOk = 'Η εξαγωγή σας ξεκίνησε.';
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Αποτυχία εξαγωγής';
    } finally {
      this.busy = false;
    }
  }

  async deleteAccount(): Promise<void> {
    if (!confirm('Οριστική διαγραφή του λογαριασμού και όλων των δεδομένων σας; Αυτή η ενέργεια δεν αναστρέφεται.')) return;
    this.busy = true;
    this.error = '';
    try {
      await this.authService.deleteAccount();
      this.router.navigate(['/']);
    } catch (err) {
      this.busy = false;
      this.error = err instanceof Error ? err.message : 'Αποτυχία διαγραφής';
    }
  }
}
