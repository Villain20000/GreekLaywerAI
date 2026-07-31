import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

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

@Injectable({
  providedIn: 'root'
})
export class BillingService {
  private apiUrl = `${environment.apiBaseUrl}/api`;

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${localStorage.getItem('nomos_token') || ''}` };
  }

  /** Start Stripe Checkout for a tier; returns the redirect URL. */
  async createCheckoutSession(tier: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/billing/create-checkout-session`, {
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

  async getSubscription(): Promise<SubscriptionState> {
    const res = await fetch(`${this.apiUrl}/subscriptions`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Get subscription failed (HTTP ${res.status})`);
    return res.json();
  }

  async history(): Promise<Subscription[]> {
    const res = await fetch(`${this.apiUrl}/subscriptions/history`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Subscription history failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.subscriptions || [];
  }

  async cancel(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/subscriptions/cancel`, {
      method: 'POST',
      headers: this.headers()
    });
    if (!res.ok) throw new Error(`Cancel failed (HTTP ${res.status})`);
  }

  async upgrade(tier: string): Promise<string> {
    const res = await fetch(`${this.apiUrl}/subscriptions/upgrade`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier })
    });
    if (!res.ok) throw new Error(`Upgrade failed (HTTP ${res.status})`);
    const data = await res.json();
    return data.url;
  }
}
