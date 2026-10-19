import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { BillingService, Invoice, Subscription, SubscriptionState } from '../../services/billing.service';
import { ConfirmService } from '../../services/confirm.service';

const INVOICE_PAGE_SIZE = 10;

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
          <button
            *ngIf="canReactivate"
            class="nl-btn-secondary nl-reactivate-btn"
            type="button"
            (click)="reactivate()"
            [disabled]="busy"
          >
            {{ 'billing.reactivate' | translate }}
          </button>
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

      <section class="nl-admin-card">
        <h2>{{ 'subscriptions.paymentHistory' | translate }}</h2>
        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'subscriptions.paymentHistoryAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'subscriptions.colInvoiceDate' | translate }}</th>
                <th>{{ 'subscriptions.colInvoiceAmount' | translate }}</th>
                <th>{{ 'subscriptions.colInvoiceStatus' | translate }}</th>
                <th>{{ 'subscriptions.colInvoiceLink' | translate }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let invoice of invoices">
                <td>{{ invoice.created_at | date: 'short' }}</td>
                <td>{{ invoiceAmount(invoice) }}</td>
                <td>{{ invoice.status }}</td>
                <td>
                  <span class="nl-invoice-links">
                    <a
                      *ngIf="invoice.hosted_invoice_url"
                      [href]="invoice.hosted_invoice_url"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ 'subscriptions.viewInvoice' | translate }}</a>
                    <a
                      *ngIf="invoice.invoice_pdf"
                      [href]="invoice.invoice_pdf"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ 'subscriptions.downloadPdf' | translate }}</a>
                    <span *ngIf="!invoice.hosted_invoice_url && !invoice.invoice_pdf">—</span>
                  </span>
                </td>
              </tr>
              <tr *ngIf="invoicesLoading">
                <td colspan="4" class="nl-empty-row">{{ 'subscriptions.paymentHistoryLoading' | translate }}</td>
              </tr>
              <tr *ngIf="!invoicesLoading && !invoices.length">
                <td colspan="4" class="nl-empty-row">{{ 'subscriptions.paymentHistoryEmpty' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="nl-error-msg" *ngIf="invoicesError">{{ invoicesError }}</p>
        <div class="nl-invoice-pagination" *ngIf="invoiceTotal > 0">
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="prevInvoicePage()"
            [disabled]="invoicesLoading || invoiceOffset === 0"
          >{{ 'subscriptions.prevPage' | translate }}</button>
          <span class="nl-prompt-text">{{ 'subscriptions.pageOf' | translate: { page: invoicePage, pages: invoicePages } }}</span>
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="nextInvoicePage()"
            [disabled]="invoicesLoading || invoiceOffset + invoiceLimit >= invoiceTotal"
          >{{ 'subscriptions.nextPage' | translate }}</button>
        </div>
      </section>

      <p class="nl-error-msg" *ngIf="error">{{ error }}</p>
      <p class="nl-success-msg" *ngIf="cancelOk || reactivateOk">{{ cancelOk || reactivateOk }}</p>
    </div>
  `,
  styles: [`
    .nl-invoice-links { display: flex; flex-wrap: wrap; gap: 0.75rem; }
    .nl-invoice-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin-top: 0.75rem; }
  `]
})
export class SubscriptionsComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  state: SubscriptionState | null = null;
  history: Subscription[] = [];
  invoices: Invoice[] = [];
  invoiceTotal = 0;
  invoiceLimit = INVOICE_PAGE_SIZE;
  invoiceOffset = 0;
  invoicesLoading = false;
  invoicesError = '';
  busy = false;
  error = '';
  cancelOk = '';
  reactivateOk = '';

  constructor(
    private billingService: BillingService,
    private confirm: ConfirmService
  ) {}

  get canReactivate(): boolean {
    return this.state?.subscription?.status === 'canceled_at_period_end';
  }

  get invoicePage(): number {
    return Math.floor(this.invoiceOffset / this.invoiceLimit) + 1;
  }

  get invoicePages(): number {
    return Math.max(1, Math.ceil(this.invoiceTotal / this.invoiceLimit));
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadSummary(), this.loadInvoices()]);
  }

  private async loadSummary(): Promise<void> {
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

  private async loadInvoices(): Promise<void> {
    this.invoicesLoading = true;
    this.invoicesError = '';
    try {
      const page = await this.billingService.listInvoices(this.invoiceLimit, this.invoiceOffset);
      this.invoices = page.invoices;
      this.invoiceTotal = page.total;
    } catch (err) {
      console.warn('Unable to load the payment history', err);
      this.invoices = [];
      this.invoiceTotal = 0;
      this.invoicesError = this.translate.instant('subscriptions.paymentHistoryError');
    } finally {
      this.invoicesLoading = false;
    }
  }

  /** Amounts are stored in the currency's minor unit (cents for EUR). */
  invoiceAmount(invoice: Invoice): string {
    const cents = invoice.amount_paid ?? invoice.amount_due ?? 0;
    const amount = (cents / 100).toFixed(2);
    const currency = (invoice.currency || '').toUpperCase();
    return currency ? `${amount} ${currency}` : amount;
  }

  async prevInvoicePage(): Promise<void> {
    if (this.invoicesLoading || this.invoiceOffset === 0) return;
    this.invoiceOffset = Math.max(0, this.invoiceOffset - this.invoiceLimit);
    await this.loadInvoices();
  }

  async nextInvoicePage(): Promise<void> {
    if (this.invoicesLoading || this.invoiceOffset + this.invoiceLimit >= this.invoiceTotal) return;
    this.invoiceOffset += this.invoiceLimit;
    await this.loadInvoices();
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
    this.reactivateOk = '';
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

  /** Undo a cancellation scheduled at period end. */
  async reactivate(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.cancelOk = '';
    this.reactivateOk = '';
    try {
      await this.billingService.reactivate();
      this.state = await this.billingService.getSubscription();
      this.reactivateOk = this.translate.instant('billing.reactivatedOk');
    } catch (err) {
      console.warn('Unable to reactivate the subscription', err);
      this.error = this.translate.instant('billing.reactivateError');
    } finally {
      this.busy = false;
    }
  }
}
