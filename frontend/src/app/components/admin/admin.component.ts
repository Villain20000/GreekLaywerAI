import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import gsap from 'gsap';
import { AdminService, AdminUser } from '../../services/admin.service';
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
 * The whole component carries zero per-component CSS (so the
 * `anyComponentStyle: 4 kB` budget is trivially honored) and the TS
 * logic is verbatim — loadUsers, changeRole/Tier gating, optimistic
 * update + revert, magic-link banner dismissal, GSAP fade-in for the
 * table card.
 */
@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="nl-admin-layout">
      <p class="nl-admin-who">
        Signed in as <strong>{{ auth.userValue?.email }}</strong>
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
          <strong>Signed in via magic link</strong>
          <span class="nl-magic-banner-sub">
            Bypass auto-fills your session without a password. This
            banner clears automatically in 30 seconds, or you can
            dismiss it now.
          </span>
        </span>
        <button
          class="nl-magic-banner-dismiss"
          (click)="dismissMagicLinkBanner()"
          aria-label="Dismiss magic-link banner"
          type="button"
        >✕</button>
      </div>

      <section class="nl-admin-actions">
        <button
          class="refresh-btn"
          (click)="loadUsers()"
          [disabled]="isLoading"
          type="button"
        >
          {{ isLoading ? 'Refreshing…' : 'Refresh users' }}
        </button>
      </section>

      <section class="nl-admin-card">
        <h3>Users ({{ users.length }})</h3>
        <div style="overflow-x: auto;">
          <table class="nl-admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Email</th>
                <th>Role</th>
                <th>Tier</th>
                <th>Created</th>
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
                    title="That's you"
                  >🛡️ You</span>
                </td>
                <td>
                  <select
                    [ngModel]="u.role"
                    (ngModelChange)="changeRole(u, $event)"
                    [disabled]="isSelf(u) || saving[u.id]"
                    title="Role"
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
                    title="Subscription tier"
                  >
                    <option value="basic">basic</option>
                    <option value="pro">pro</option>
                    <option value="enterprise">enterprise</option>
                  </select>
                </td>
                <td class="nl-mono">{{ formatDate(u.created_at) }}</td>
              </tr>
              <tr *ngIf="!isLoading && users.length === 0">
                <td colspan="5" class="nl-empty-row">No users yet.</td>
              </tr>
              <tr *ngIf="isLoading && users.length === 0">
                <td colspan="5" class="nl-empty-row">Loading…</td>
              </tr>
            </tbody>
          </table>
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
          aria-label="Dismiss"
          type="button"
        >✕</button>
      </div>
    </div>
  `,
  // Phase 27 — zero per-component CSS. Every visual surface lives in
  // src/styles.scss under .nl-admin-* / .nl-magic-banner-* / .nl-role-pill
  // / .nl-you-badge / .nl-mono / .nl-toast-error utility classes (or
  // aliases for legacy selectors).
  styles: []
})
export class AdminComponent implements OnInit {
  users: AdminUser[] = [];
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

  constructor(
    public auth: AuthService,
    private adminService: AdminService,
    private router: Router
  ) {}

  ngOnInit() {
    this.loadUsers();
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

  loadUsers() {
    this.isLoading = true;
    this.errorMessage = '';
    this.adminService.listUsers().subscribe({
      next: (users) => {
        this.users = users;
        this.isLoading = false;
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err?.message || 'Failed to load users';
      }
    });
  }

  changeRole(u: AdminUser, newRole: AdminUser['role']) {
    if (newRole === u.role) return;
    // Defence-in-depth: prevent self-demotion in the UI.
    if (this.isSelf(u) && newRole !== 'admin') {
      this.errorMessage = 'You cannot demote yourself from here.';
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
        const msg = err?.message || 'Update failed';
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
