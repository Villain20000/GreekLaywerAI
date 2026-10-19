import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import gsap from 'gsap';
import {
  AdminService,
  AdminUser,
  AuditLogEntry,
  FeedbackSummary
} from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';

/**
 * Phase 27 — AdminComponent.
 *
 * The previous version carried its own piecemeal header (a brand row +
 * "back to chat" link + back to change-password link + Refresh + Logout).
 * That chrome is now redundant with the new sticky top menu on every
 * authenticated route, so we drop it here. The page-level breadcrumb
 * "Signed in as <email> <role>" stays — it's a useful in-page reminder
 * of who's holding the admin token, distinct from the menu chrome.
 *
 * Visual surface:
 *   - .nl-admin-layout       page shell (resized from 100vh to 100vh − 64px
 *                             so it sits cleanly below the fixed menu)
 *   - .nl-admin-who          the role pill / "Signed in as ..." line
 *   - .nl-magic-banner       the Phase 25 amber banner
 *   - .nl-admin-card         the users table card
 *   - .nl-admin-table        the table itself + .nl-mono for ids/dates,
 *                             .nl-you-badge for the current row,
 *                             .nl-empty-row for empty/loading states
 *   - .nl-toast-error        fixed bottom-right toast for save failures
 *
 * 2-4 additions: user search/pagination, a feedback-window selector, an
 * audit-log viewer over GET /api/admin/audit-log, and a link to the
 * otherwise-orphaned /admin/documents page.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe],
  template: `
    <div class="nl-admin-layout">
      <p class="nl-admin-who">
        {{ 'admin.signedInAs' | translate }} <strong>{{ auth.userValue?.email }}</strong>
        <span
          class="nl-role-pill"
          [class.admin]="auth.userValue?.role === 'admin'"
        >{{ auth.userValue?.role }}</span>
      </p>

      <!--
        Phase 25 (admin bypass): brief dismissable banner so the operator
        can tell at a glance when they landed via the magic-link URL
        versus a normal password login. Auto-hides after ~30s or via
        the × button. Sits above .nl-admin-card so it doesn't push the
        table layout around when dismissed later.
      -->
      <div
        *ngIf="bannerVisible"
        class="nl-magic-banner"
        role="status"
        aria-live="polite"
      >
        <span class="nl-magic-banner-icon" aria-hidden="true">⚡</span>
        <span>
          <strong>{{ 'admin.magic.title' | translate }}</strong>
          <span class="nl-magic-banner-sub">
            {{ 'admin.magic.body' | translate }}
          </span>
        </span>
        <button
          class="nl-magic-banner-dismiss"
          (click)="dismissMagicLinkBanner()"
          [attr.aria-label]="'admin.magic.dismiss' | translate"
          type="button"
        >✕</button>
      </div>

      <section class="nl-admin-actions">
        <input
          class="nl-input"
          type="search"
          name="userSearch"
          [(ngModel)]="userQuery"
          (keyup.enter)="applyUserSearch()"
          [attr.placeholder]="'admin.searchUsers' | translate"
          [attr.aria-label]="'admin.searchUsers' | translate"
        />
        <button class="refresh-btn" (click)="applyUserSearch()" type="button">{{ 'admin.search' | translate }}</button>
        <button
          *ngIf="userQuery"
          class="nl-btn-secondary"
          (click)="clearUserSearch()"
          type="button"
        >{{ 'admin.clear' | translate }}</button>
        <button
          class="refresh-btn"
          (click)="loadUsers()"
          [disabled]="isLoading"
          type="button"
        >
          {{ (isLoading ? 'admin.refreshing' : 'admin.refreshUsers') | translate }}
        </button>
        <button
          class="nl-btn-secondary"
          (click)="openAdminDocuments()"
          type="button"
          [attr.title]="'admin.openDocumentsTitle' | translate"
        >{{ 'admin.openDocuments' | translate }}</button>
      </section>

      <section class="nl-admin-card nl-feedback-summary">
        <div class="nl-feedback-summary-heading">
          <div>
            <span class="nl-admin-eyebrow">
              {{ 'admin.feedback.eyebrow' | translate: { days: feedbackSummary?.days ?? feedbackDays } }}
            </span>
            <h3>{{ 'admin.feedback.title' | translate }}</h3>
          </div>
          <div class="nl-feedback-controls">
            <label class="nl-feedback-window">
              <span>{{ 'admin.feedback.window' | translate }}</span>
              <select
                [ngModel]="feedbackDays"
                (ngModelChange)="onFeedbackDaysChange($event)"
                [attr.aria-label]="'admin.feedback.windowAria' | translate"
              >
                <option *ngFor="let d of feedbackDayOptions" [ngValue]="d">{{ 'admin.feedback.lastDays' | translate: { days: d } }}</option>
              </select>
            </label>
            <strong *ngIf="feedbackSummary && feedbackSummary.helpfulRate !== null">
              {{ 'admin.feedback.helpfulPercent' | translate: { percent: helpfulRatePercent() } }}
            </strong>
          </div>
        </div>
        <div class="nl-feedback-stats" *ngIf="feedbackSummary">
          <span><b>{{ feedbackSummary.total }}</b> {{ 'admin.feedback.totalLabel' | translate }}</span>
          <span class="positive"><b>{{ feedbackSummary.helpful }}</b> {{ 'admin.feedback.helpfulLabel' | translate }}</span>
          <span class="negative"><b>{{ feedbackSummary.unhelpful }}</b> {{ 'admin.feedback.unhelpfulLabel' | translate }}</span>
        </div>
        <p class="nl-empty-row" *ngIf="!feedbackSummary">{{ 'admin.feedback.none' | translate }}</p>
      </section>

      <section class="nl-admin-card">
        <h3>{{ 'admin.users.title' | translate: { total: userTotal } }}</h3>
        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'admin.users.tableAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'admin.users.colId' | translate }}</th>
                <th>{{ 'admin.users.colEmail' | translate }}</th>
                <th>{{ 'admin.users.colRole' | translate }}</th>
                <th>{{ 'admin.users.colTier' | translate }}</th>
                <th>{{ 'admin.users.colCreated' | translate }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                *ngFor="let u of users; trackBy: trackById"
                [class.is-self]="isSelf(u)"
              >
                <td class="nl-mono">{{ u.id }}</td>
                <td>
                  {{ u.email }}
                  <span
                    *ngIf="isSelf(u)"
                    class="nl-you-badge"
                    [attr.title]="'admin.users.youTitle' | translate"
                  >{{ 'admin.users.you' | translate }}</span>
                </td>
                <td>
                  <select
                    [ngModel]="u.role"
                    (ngModelChange)="changeRole(u, $event)"
                    [disabled]="isSelf(u) || saving[u.id]"
                    [attr.title]="'admin.users.roleTitle' | translate"
                  >
                    <option value="user">user</option>
                    <option value="admin">admin</option>
                    <option value="enterprise">enterprise</option>
                  </select>
                </td>
                <td>
                  <select
                    [ngModel]="u.subscription_tier"
                    (ngModelChange)="changeTier(u, $event)"
                    [disabled]="saving[u.id]"
                    [attr.title]="'admin.users.tierTitle' | translate"
                  >
                    <option value="basic">basic</option>
                    <option value="pro">pro</option>
                    <option value="enterprise">enterprise</option>
                  </select>
                </td>
                <td class="nl-mono">{{ formatDate(u.created_at) }}</td>
              </tr>
              <tr *ngIf="!isLoading && users.length === 0">
                <td colspan="5" class="nl-empty-row">
                  {{ (userQuery ? 'admin.users.emptySearch' : 'admin.users.empty') | translate }}
                </td>
              </tr>
              <tr *ngIf="isLoading && users.length === 0">
                <td colspan="5" class="nl-empty-row">{{ 'admin.users.loading' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="nl-pager" *ngIf="userTotal > 0">
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="prevUserPage()"
            [disabled]="userOffset === 0 || isLoading"
          >{{ 'admin.users.previous' | translate }}</button>
          <span class="nl-pager-label">
            {{ 'admin.users.pager' | translate: { start: userPageStart(), end: userPageEnd(), total: userTotal } }}
          </span>
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="nextUserPage()"
            [disabled]="userOffset + userLimit >= userTotal || isLoading"
          >{{ 'admin.users.next' |translate }}</button>
        </div>
      </section>

      <section class="nl-admin-card">
        <h3>{{ 'admin.audit.title' | translate: { total: auditTotal } }}</h3>
        <div class="nl-admin-actions nl-audit-filters">
          <input
            class="nl-input"
            type="text"
            name="auditAction"
            [(ngModel)]="auditAction"
            (keyup.enter)="applyAuditFilters()"
            [attr.placeholder]="'admin.audit.actionPlaceholder' | translate"
            [attr.aria-label]="'admin.audit.actionAria' | translate"
          />
          <input
            class="nl-input nl-input-narrow"
            type="number"
            min="1"
            name="auditUserId"
            [(ngModel)]="auditUserId"
            (keyup.enter)="applyAuditFilters()"
            [attr.placeholder]="'admin.audit.userIdPlaceholder' | translate"
            [attr.aria-label]="'admin.audit.userIdAria' | translate"
          />
          <button class="refresh-btn" type="button" (click)="applyAuditFilters()">{{ 'admin.audit.filter' | translate }}</button>
          <button class="nl-btn-secondary" type="button" (click)="clearAuditFilters()">{{ 'admin.audit.clear' | translate }}</button>
        </div>
        <div class="nl-table-scroll" tabindex="0" role="region" [attr.aria-label]="'admin.audit.tableAria' | translate">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>{{ 'admin.audit.colWhen' | translate }}</th>
                <th>{{ 'admin.audit.colUser' | translate }}</th>
                <th>{{ 'admin.audit.colAction' | translate }}</th>
                <th>{{ 'admin.audit.colResource' | translate }}</th>
                <th>{{ 'admin.audit.colChange' | translate }}</th>
                <th>{{ 'admin.audit.colIp' | translate }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let entry of auditLog; trackBy: trackAuditById">
                <td class="nl-mono">{{ formatDate(entry.created_at) }}</td>
                <td class="nl-mono">{{ entry.user_id ?? '—' }}</td>
                <td><code class="nl-mono">{{ entry.action }}</code></td>
                <td class="nl-mono">
                  {{ entry.resource_type || '—' }}<span *ngIf="entry.resource_id">#{{ entry.resource_id }}</span>
                </td>
                <td class="nl-mono" [title]="formatAuditValue(entry.new_value)">
                  {{ formatAuditValue(entry.old_value) }} → {{ formatAuditValue(entry.new_value) }}
                </td>
                <td class="nl-mono">{{ entry.ip_address || '—' }}</td>
              </tr>
              <tr *ngIf="!auditLoading && auditLog.length === 0">
                <td colspan="6" class="nl-empty-row">{{ 'admin.audit.empty' | translate }}</td>
              </tr>
              <tr *ngIf="auditLoading && auditLog.length === 0">
                <td colspan="6" class="nl-empty-row">{{ 'admin.audit.loading' | translate }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="nl-pager" *ngIf="auditTotal > 0">
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="prevAuditPage()"
            [disabled]="auditOffset === 0 || auditLoading"
          >{{ 'admin.audit.previous' | translate }}</button>
          <span class="nl-pager-label">
            {{ 'admin.audit.pager' | translate: { start: auditPageStart(), end: auditPageEnd(), total: auditTotal } }}
          </span>
          <button
            class="nl-btn-secondary"
            type="button"
            (click)="nextAuditPage()"
            [disabled]="auditOffset + auditLimit >= auditTotal || auditLoading"
          >{{ 'admin.audit.next' | translate }}</button>
        </div>
      </section>

      <div
        *ngIf="errorMessage"
        class="nl-toast-error"
        role="alert"
      >
        <span>⚠️ {{ errorMessage }}</span>
        <button
          (click)="errorMessage = ''"
          [attr.aria-label]="'admin.toastDismiss' | translate"
          type="button"
        >✕</button>
      </div>
    </div>
  `,
  // Phase 27 — zero per-component CSS. Every visual surface lives in
  // src/styles.scss under .nl-admin-* / .nl-magic-banner-* / .nl-role-pill
  // / .nl-you-badge / .nl-mono / .nl-toast-error utility classes (or
  // aliases for legacy selectors). 2-4 adds only a few layout helpers here.
  styles: [`
    .nl-feedback-controls { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .nl-feedback-window { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: var(--nl-fg-subtle); }
    .nl-feedback-window select { background: var(--nl-bg-input); color: var(--nl-fg); border: 1px solid var(--nl-border); padding: 0.35rem 0.55rem; border-radius: var(--nl-radius-sm); font-size: 0.82rem; }
    .nl-audit-filters { padding: 0 0 var(--nl-space-4); flex-wrap: wrap; }
    .nl-input-narrow { max-width: 7.5rem; }
    .nl-pager { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; margin-top: var(--nl-space-4); }
    .nl-pager-label { font-size: 0.8rem; color: var(--nl-fg-subtle); }
  `]
})
export class AdminComponent implements OnInit {
  private readonly translate = inject(TranslateService);

  users: AdminUser[] = [];
  feedbackSummary: FeedbackSummary | null = null;
  isLoading = false;
  errorMessage = '';
  saving: Record<number, boolean> = {};
  // Phase 25 (admin bypass): the "Signed in via magic link" banner is
  // surfaced whenever AuthService flags a recent magic-link redeem.
  // bannerVisible is the local UI state; the underlying signal lives
  // in sessionStorage and is consumed-once by AuthService so a
  // re-navigation to /admin within the banner window won't re-show it.
  bannerVisible = false;
  /** Auto-hide timer; null when not active. Cleared on manual dismiss. */
  private magicBannerHideTimer: ReturnType<typeof setTimeout> | null = null;

  // 2-4: users list search + pagination.
  userQuery = '';
  userLimit = 25;
  userOffset = 0;
  userTotal = 0;

  // 2-4: feedback window selector (was hard-coded to 30 days).
  readonly feedbackDayOptions = [7, 30, 90, 365];
  feedbackDays = 30;

  // 2-4: audit-log viewer.
  auditLog: AuditLogEntry[] = [];
  auditTotal = 0;
  auditLimit = 50;
  auditOffset = 0;
  auditAction = '';
  auditUserId: number | null = null;
  auditLoading = false;

  constructor(
    public auth: AuthService,
    private adminService: AdminService,
    private router: Router
  ) {}

  ngOnInit() {
    this.loadUsers();
    this.loadFeedbackSummary();
    this.loadAuditLog();
    // Subtle fade-in for the table card. Uses the .nl-admin-card global
    // selector so the GSAP target matches the rendered class name.
    setTimeout(() => {
      gsap.from('.nl-admin-card', { opacity: 0, y: 12, duration: 0.5, ease: 'power2.out' });
    }, 0);

    // Phase 25 (admin bypass): surface the recent-magic-link banner if
    // AuthService flagged this session. The flag itself is consumed-once
    // (AuthService.consumeMagicLinkBannerFlag clears the storage entry
    // before returning true) so re-entering /admin within the 30s
    // window won't re-show it. The 30s wallclock timer is also cleared
    // synchronously on manual dismiss so a × click wins.
    if (this.auth.consumeMagicLinkBannerFlag()) {
      this.bannerVisible = true;
      this.magicBannerHideTimer = setTimeout(
        () => this.dismissMagicLinkBanner(),
        30_000
      );
    }
  }

  trackById(_index: number, u: AdminUser): number {
    return u.id;
  }

  trackAuditById(_index: number, entry: AuditLogEntry): number {
    return entry.id;
  }

  isSelf(u: AdminUser): boolean {
    return this.auth.userValue?.id === u.id;
  }

  formatDate(d: string | Date | undefined | null): string {
    if (!d) return '—';
    try {
      const date = typeof d === 'string' ? new Date(d) : d;
      if (isNaN(date.getTime())) return String(d);
      return date.toISOString().slice(0, 10);
    } catch {
      return String(d);
    }
  }

  formatAuditValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'string') return value;
    try {
      const json = JSON.stringify(value);
      return json.length > 80 ? `${json.slice(0, 77)}…` : json;
    } catch {
      return String(value);
    }
  }

  helpfulRatePercent(): string {
    const rate = this.feedbackSummary?.helpfulRate;
    if (rate === null || rate === undefined) return '';
    return (rate * 100).toFixed(0);
  }

  loadFeedbackSummary(): void {
    this.adminService.getFeedbackSummary(this.feedbackDays).subscribe({
      next: (summary) => { this.feedbackSummary = summary; },
      error: () => { this.feedbackSummary = null; }
    });
  }

  onFeedbackDaysChange(days: number | string): void {
    const parsed = typeof days === 'number' ? days : Number.parseInt(days, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return;
    this.feedbackDays = parsed;
    this.loadFeedbackSummary();
  }

  loadUsers() {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.listUsers({
      q: this.userQuery.trim() || undefined,
      limit: this.userLimit,
      offset: this.userOffset
    }).subscribe({
      next: (page) => {
        this.users = page.users;
        this.userTotal = page.total;
        this.isLoading = false;
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err?.message || this.translate.instant('admin.loadUsersError');
      }
    });
  }

  applyUserSearch(): void {
    this.userOffset = 0;
    this.loadUsers();
  }

  clearUserSearch(): void {
    this.userQuery = '';
    this.userOffset = 0;
    this.loadUsers();
  }

  prevUserPage(): void {
    if (this.userOffset === 0) return;
    this.userOffset = Math.max(0, this.userOffset - this.userLimit);
    this.loadUsers();
  }

  nextUserPage(): void {
    if (this.userOffset + this.userLimit >= this.userTotal) return;
    this.userOffset += this.userLimit;
    this.loadUsers();
  }

  userPageStart(): number {
    return this.userTotal === 0 ? 0 : this.userOffset + 1;
  }

  userPageEnd(): number {
    return this.userOffset + this.users.length;
  }

  loadAuditLog(): void {
    this.auditLoading = true;
    this.adminService.listAuditLog({
      userId: this.auditUserId || undefined,
      action: this.auditAction.trim() || undefined,
      limit: this.auditLimit,
      offset: this.auditOffset
    }).subscribe({
      next: (page) => {
        this.auditLog = page.auditLog;
        this.auditTotal = page.total;
        this.auditLoading = false;
      },
      error: (err) => {
        this.auditLoading = false;
        this.errorMessage = err?.message || this.translate.instant('admin.loadAuditError');
      }
    });
  }

  applyAuditFilters(): void {
    this.auditOffset = 0;
    this.loadAuditLog();
  }

  clearAuditFilters(): void {
    this.auditAction = '';
    this.auditUserId = null;
    this.auditOffset = 0;
    this.loadAuditLog();
  }

  prevAuditPage(): void {
    if (this.auditOffset === 0) return;
    this.auditOffset = Math.max(0, this.auditOffset - this.auditLimit);
    this.loadAuditLog();
  }

  nextAuditPage(): void {
    if (this.auditOffset + this.auditLimit >= this.auditTotal) return;
    this.auditOffset += this.auditLimit;
    this.loadAuditLog();
  }

  auditPageStart(): number {
    return this.auditTotal === 0 ? 0 : this.auditOffset + 1;
  }

  auditPageEnd(): number {
    return this.auditOffset + this.auditLog.length;
  }

  openAdminDocuments(): void {
    this.router.navigate(['/admin/documents']);
  }

  changeRole(u: AdminUser, newRole: AdminUser['role']) {
    if (newRole === u.role) return;
    // Defence-in-depth: prevent self-demotion in the UI.
    if (this.isSelf(u) && newRole !== 'admin') {
      this.errorMessage = this.translate.instant('admin.selfDemoteError');
      return;
    }
    this.persist(u, { role: newRole }, () => this.adminService.updateRole(u.id, newRole));
  }

  changeTier(u: AdminUser, newTier: AdminUser['subscription_tier']) {
    if (newTier === u.subscription_tier) return;
    this.persist(u, { subscription_tier: newTier }, () => this.adminService.updateTier(u.id, newTier));
  }

  private persist(
    u: AdminUser,
    patch: Partial<Pick<AdminUser, 'role' | 'subscription_tier'>>,
    op: () => ReturnType<AdminService['updateRole']>
  ) {
    const idx = this.users.findIndex((x) => x.id === u.id);
    if (idx < 0) return;
    const previous = { ...this.users[idx] };
    // Optimistic update
    this.users[idx] = { ...this.users[idx], ...patch };
    this.saving[u.id] = true;
    this.errorMessage = '';

    op().subscribe({
      next: (updated) => {
        this.users[idx] = updated;
        this.saving[u.id] = false;
      },
      error: (err) => {
        // Revert
        this.users[idx] = previous;
        this.saving[u.id] = false;
        const msg = err?.message || this.translate.instant('admin.updateFailed');
        this.errorMessage = `${u.email}: ${msg}`;
      }
    });
  }

  /**
   * Phase 25 (admin bypass): explicit user-dismiss of the magic-link
   * banner. Cancels the auto-hide timer if it's still pending. The
   * sessionStorage flag was already cleared synchronously by
   * AuthService.consumeMagicLinkBannerFlag in ngOnInit, so this method
   * only touches local UI state.
   */
  dismissMagicLinkBanner(): void {
    this.bannerVisible = false;
    if (this.magicBannerHideTimer !== null) {
      clearTimeout(this.magicBannerHideTimer);
      this.magicBannerHideTimer = null;
    }
  }

  /**
   * Phase 27: logout moved to the top menu. Keeping the method signature
   * so any future direct-call site (e.g., a hidden "force logout" admin
   * button) doesn't break — it just routes the same way as the menu.
   */
  logout() {
    this.auth.logout();
  }
}
