import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface Subscription {
  id: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string | null;
  current_period_end: string | null;
  created_at: string;
}

export interface SubscriptionState {
  subscription: Subscription | null;
  tier: string;
}

/**
 * Plan row rendered by the billing page. The catalog is owned by the backend
 * (GET /api/billing/plans) — the UI must not hardcode names/prices/features.
 */
export interface TierPlan {
  id: string;
  tier: string;
  name: string;
  price: string;
  features: string[];
  recommended?: boolean;
}

/** Stripe invoice row from GET /api/subscriptions/invoices. */
export interface Invoice {
  id: number;
  stripe_invoice_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  amount_due: number | null;
  amount_paid: number | null;
  currency: string | null;
  status: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  updated_at?: string;
}

export interface InvoicePage {
  invoices: Invoice[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable({
  providedIn: 'root'
})
export class BillingService {
  private apiUrl = `${environment.apiBaseUrl}/api`;

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` };
  }

  /** Server-owned plan catalog (GET /api/billing/plans). */
  async getPlans(): Promise<TierPlan[]> {
    const res = await apiFetch(`${this.apiUrl}/billing/plans`, { headers: this.headers() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Plans failed (HTTP ${res.status})`);
    }
    return data.plans || [];
  }

  /** Start Stripe Checkout for a tier; returns the redirect URL. */
  async createCheckoutSession(tier: string): Promise<string> {
    const res = await apiFetch(`${this.apiUrl}/billing/create-checkout-session`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Checkout failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    return data.url;
  }

  /**
   * Create a Stripe Billing Portal session (live mode only) and return its
   * URL. Mock mode 403s server-side with a readable error.
   */
  async createPortalSession(): Promise<string> {
    const res = await apiFetch(`${this.apiUrl}/billing/portal`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Portal failed (HTTP ${res.status})`);
    }
    return data.url;
  }

  async getSubscription(): Promise<SubscriptionState> {
    const res = await apiFetch(`${this.apiUrl}/subscriptions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Get subscription failed (HTTP ${res.status})`);
    return res.json();
  }

  /**
   * Mock-mode only: after the mock checkout redirect
   * (`?mock_payment=success&tier=…`), confirm the "payment" for real by
   * applying the same tier-sync a Stripe webhook performs. The backend 403s
   * this route in live Stripe mode.
   */
  async completeMockCheckout(tier: string): Promise<{ tier: string; status: string }> {
    const res = await apiFetch(`${this.apiUrl}/billing/mock-complete`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Mock checkout failed (HTTP ${res.status})`);
    }
    return data;
  }

  async history(): Promise<Subscription[]> {
    const res = await apiFetch(`${this.apiUrl}/subscriptions/history`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Subscription history failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.subscriptions || [];
  }

  /** Paginated payment history (GET /api/subscriptions/invoices). */
  async listInvoices(limit = 10, offset = 0): Promise<InvoicePage> {
    const res = await apiFetch(
      `${this.apiUrl}/subscriptions/invoices?limit=${limit}&offset=${offset}`,
      { headers: this.headers() }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Invoices failed (HTTP ${res.status})`);
    }
    return {
      invoices: data.invoices || [],
      total: Number(data.total) || 0,
      limit: Number(data.limit) || limit,
      offset: Number(data.offset) || 0
    };
  }

  async cancel(): Promise<void> {
    const res = await apiFetch(`${this.apiUrl}/subscriptions/cancel`, {
      method: 'POST',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Cancel failed (HTTP ${res.status})`);
  }

  /**
   * Undo a cancellation scheduled at period end: live mode flips Stripe's
   * `cancel_at_period_end` back to false and restores the local status.
   */
  async reactivate(): Promise<{ id: number; status: string } | null> {
    const res = await apiFetch(`${this.apiUrl}/subscriptions/reactivate`, {
      method: 'POST',
      headers: this.headers()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Reactivate failed (HTTP ${res.status})`);
    }
    return data.subscription || null;
  }
}
