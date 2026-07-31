import { Component, OnInit, ElementRef, HostListener, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService, AuthUser } from '../../services/auth.service';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-menu',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive],
  template: `
    <!--
      Phase 27: top-level sticky navigation. Reads from AuthService for the
      current user / role gate on the Admin link, and ThemeService for the
      sun/moon glyph. The user-menu dropdown closes on outside-click via a
      HostListener on document;mousedown, and on Escape via keydown.escape.
    -->
    <nav class="nl-menu" role="navigation" aria-label="Primary">
      <a routerLink="/chat" class="nl-menu-brand" title="NomosAI">
        <span class="nl-menu-mark" aria-hidden="true">§</span>
        <span class="nl-menu-title">NomosAI</span>
      </a>

      <div class="nl-menu-links">
        <a routerLink="/chat"
           routerLinkActive="active"
           [routerLinkActiveOptions]="{ exact: true }"
           class="nl-menu-link"
           title="Open the AI workspace">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
          </svg>
          <span>Chat</span>
        </a>
        <a routerLink="/documents"
           routerLinkActive="active"
           class="nl-menu-link"
           title="Upload and search your legal documents">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
          </svg>
          <span>Documents</span>
        </a>
        <a routerLink="/conversations"
           routerLinkActive="active"
           class="nl-menu-link"
           title="Browse your past conversations">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/>
          </svg>
          <span>Conversations</span>
        </a>
        <a routerLink="/billing"
           routerLinkActive="active"
           class="nl-menu-link"
           title="Plans and upgrade">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>
          </svg>
          <span>Plans</span>
        </a>
        <a *ngIf="auth.isAdmin"
           routerLink="/admin"
           routerLinkActive="active"
           class="nl-menu-link"
           title="Open the admin console">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
          </svg>
          <span>Admin</span>
        </a>
        <a routerLink="/change-password"
           routerLinkActive="active"
           class="nl-menu-link"
           title="Rotate your password (auto-logs-out other tabs)">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/>
          </svg>
          <span>Password</span>
        </a>
      </div>

      <div class="nl-menu-tail">
        <button
          class="nl-menu-icon-btn"
          type="button"
          (click)="theme.toggle()"
          [attr.aria-label]="theme.current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
          [title]="theme.current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'">
          <!-- Sun in dark mode (click → goes light), Moon in light mode -->
          <svg *ngIf="theme.current === 'dark'" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/>
          </svg>
          <svg *ngIf="theme.current === 'light'" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M21.64 13a9 9 0 1 1-10.63-10.6 1 1 0 0 1 1.05 1.37A7 7 0 0 0 19.36 12.7a1 1 0 0 1 1.37 1.05 9 9 0 0 1-1.09-.75z"/>
          </svg>
        </button>

        <div class="nl-menu-user" *ngIf="auth.user$ | async as u" (click)="toggleUserMenu($event)">
          <span class="nl-menu-avatar" aria-hidden="true">{{ initials(u) }}</span>
          <span class="nl-menu-email">{{ u.email }}</span>

          <div *ngIf="userMenuOpen()" class="nl-menu-dropdown" (click)="$event.stopPropagation()">
            <div class="nl-menu-dropdown-email">{{ u.email }}</div>
            <div class="nl-menu-dropdown-role" [class.admin]="u.role === 'admin'">{{ u.role }}</div>
            <div class="nl-menu-dropdown-divider"></div>
            <a routerLink="/profile" (click)="closeUserMenu()">Profile & data</a>
            <a routerLink="/subscriptions" (click)="closeUserMenu()">Subscription</a>
            <a routerLink="/change-password" (click)="closeUserMenu()">Change password</a>
            <button type="button" (click)="logout()">Sign out</button>
          </div>
        </div>
      </div>
    </nav>
  `,  // Phase 27 — zero per-component CSS. The menu template uses
  // .nl-menu-* utility classes that already live in src/styles.scss
  // (sticky glass top nav, brand mark, links, dropdown, user avatar,
  // theme-toggle icon button). Empty styles array honors the
  // angular.json anyComponentStyle budget without any local override.
  styles: [] 
})
export class MenuComponent implements OnInit {
  /**
   * Tracks dropdown open state. Using a signal rather than a plain boolean
   * so the template's `*ngIf="userMenuOpen()"` re-evaluates synchronously
   * after each toggle. (BehaviorSubject would work too; signal is cheaper
   * for a pure-UI flag.)
   */
  public readonly userMenuOpen = signal(false);

  constructor(
    public auth: AuthService,
    public theme: ThemeService,
    private elementRef: ElementRef<HTMLElement>
  ) {}

  ngOnInit(): void {
    // No-op: ThemeService constructor already set the document attribute,
    // AuthService already hydrated from localStorage. Nothing to async-load.
  }

  initials(u: AuthUser): string {
    const email = u.email || '';
    const local = email.split('@')[0] || '?';
    return local.slice(0, 1).toUpperCase();
  }

  toggleUserMenu(event: MouseEvent): void {
    event.stopPropagation();
    this.userMenuOpen.update(v => !v);
  }

  closeUserMenu(): void {
    this.userMenuOpen.set(false);
  }

  logout(): void {
    this.closeUserMenu();
    this.auth.logout();
  }

  /**
   * Click-outside handler. Bound at the document level so it fires for any
   * mousedown that lands outside the menu element, regardless of which
   * subtree. The HostListener pattern keeps the binding lifecycle tight to
   * the component instance (auto-cleanup on destroy).
   */
  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (!this.userMenuOpen()) return;
    const target = event.target as Node | null;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.closeUserMenu();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.userMenuOpen()) this.closeUserMenu();
  }
}
