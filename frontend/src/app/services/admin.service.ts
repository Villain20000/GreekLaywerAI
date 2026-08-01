import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';
import { apiFetch } from './api-client';

export interface AdminUser {
  id: number;
  email: string;
  role: 'user' | 'admin' | 'enterprise';
  subscription_tier: 'basic' | 'pro' | 'enterprise';
  created_at: string | Date;
}

export interface FeedbackSummary {
  days: number;
  total: number;
  helpful: number;
  unhelpful: number;
  helpfulRate: number | null;
  lastSubmittedAt: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private apiUrl = `${environment.apiBaseUrl}/api/admin`;

  constructor(private authService: AuthService) {}

  private headers(): HeadersInit {
    const token = this.authService.tokenValue;
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  /**
   * Fetch all users (admin-only backend).
   * Returns an Observable so callers can subscribe and unsubscribe cleanly.
   */
  listUsers(): Observable<AdminUser[]> {
    return new Observable<AdminUser[]>((observer) => {
      apiFetch(`${this.apiUrl}/users`, { method: 'GET', headers: this.headers() })
        .then(async (response) => {
          if (response.status === 401) {
            this.authService.logout();
            observer.error(new Error('Session expired'));
            return;
          }
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            observer.error(new Error(body?.error || `HTTP ${response.status}`));
            return;
          }
          const data = await response.json();
          observer.next(data.users || []);
          observer.complete();
        })
        .catch((err) => observer.error(err));
    });
  }

  getFeedbackSummary(days = 30): Observable<FeedbackSummary> {
    return new Observable<FeedbackSummary>((observer) => {
      apiFetch(`${this.apiUrl}/feedback-summary?days=${days}`, { method: 'GET', headers: this.headers() })
        .then(async (response) => {
          if (response.status === 401) {
            this.authService.logout();
            observer.error(new Error('Session expired'));
            return;
          }
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            observer.error(new Error(body?.error || `HTTP ${response.status}`));
            return;
          }
          observer.next(body as FeedbackSummary);
          observer.complete();
        })
        .catch((err) => observer.error(err));
    });
  }

  /**
   * PATCH a user's role. Backend blocks self-demotion with 409.
   */
  updateRole(userId: number, role: AdminUser['role']): Observable<AdminUser> {
    return new Observable<AdminUser>((observer) => {
      apiFetch(`${this.apiUrl}/users/${userId}/role`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ role })
      })
        .then(async (response) => {
          if (response.status === 401) {
            this.authService.logout();
            observer.error(new Error('Session expired'));
            return;
          }
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            observer.error(new Error(body?.error || `HTTP ${response.status}`));
            return;
          }
          observer.next(body.user);
          observer.complete();
        })
        .catch((err) => observer.error(err));
    });
  }

  /**
   * PATCH a user's subscription tier.
   */
  updateTier(userId: number, tier: AdminUser['subscription_tier']): Observable<AdminUser> {
    return new Observable<AdminUser>((observer) => {
      apiFetch(`${this.apiUrl}/users/${userId}/tier`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ tier })
      })
        .then(async (response) => {
          if (response.status === 401) {
            this.authService.logout();
            observer.error(new Error('Session expired'));
            return;
          }
          const body = await response.json().catch(() => ({}));
          if (!response.ok) {
            observer.error(new Error(body?.error || `HTTP ${response.status}`));
            return;
          }
          observer.next(body.user);
          observer.complete();
        })
        .catch((err) => observer.error(err));
    });
  }
}
