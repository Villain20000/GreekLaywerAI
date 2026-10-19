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

export interface AdminUsersQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminUsersPage {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

export interface AuditLogEntry {
  id: number;
  user_id: number | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  old_value: unknown;
  new_value: unknown;
  ip_address: string | null;
  created_at: string | Date;
}

export interface AuditLogQuery {
  userId?: number | null;
  action?: string | null;
  limit?: number;
  offset?: number;
}

export interface AuditLogPage {
  auditLog: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
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
   * Fetch users (admin-only backend). Supports the API's email search +
   * pagination params. The page envelope carries the server's `total` so the
   * component can render a pager; a legacy `{ users }`-only body still works.
   */
  listUsers(query: AdminUsersQuery = {}): Observable<AdminUsersPage> {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();

    return new Observable<AdminUsersPage>((observer) => {
      apiFetch(`${this.apiUrl}/users${qs ? `?${qs}` : ''}`, { method: 'GET', headers: this.headers() })
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
          const users: AdminUser[] = data.users || [];
          observer.next({
            users,
            total: typeof data.total === 'number' ? data.total : users.length,
            limit: typeof data.limit === 'number' ? data.limit : (query.limit ?? users.length),
            offset: typeof data.offset === 'number' ? data.offset : (query.offset ?? 0)
          });
          observer.complete();
        })
        .catch((err) => observer.error(err));
    });
  }

  /**
   * Fetch the audit trail. Mirrors GET /api/admin/audit-log's filters
   * (`userId`, `action`) and pagination (`limit`, `offset`).
   */
  listAuditLog(query: AuditLogQuery = {}): Observable<AuditLogPage> {
    const params = new URLSearchParams();
    if (query.userId) params.set('userId', String(query.userId));
    if (query.action) params.set('action', query.action);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();

    return new Observable<AuditLogPage>((observer) => {
      apiFetch(`${this.apiUrl}/audit-log${qs ? `?${qs}` : ''}`, { method: 'GET', headers: this.headers() })
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
          const auditLog: AuditLogEntry[] = body.auditLog || [];
          observer.next({
            auditLog,
            total: typeof body.total === 'number' ? body.total : auditLog.length,
            limit: typeof body.limit === 'number' ? body.limit : (query.limit ?? auditLog.length),
            offset: typeof body.offset === 'number' ? body.offset : (query.offset ?? 0)
          });
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
