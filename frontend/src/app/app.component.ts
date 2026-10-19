import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import {
  Router,
  RouterOutlet,
  NavigationEnd,
  ActivatedRoute
} from '@angular/router';
import { filter, map, startWith } from 'rxjs/operators';
import { TranslateModule } from '@ngx-translate/core';
import { MenuComponent } from './components/menu/menu.component';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { LanguageSwitcherComponent } from './i18n/language-switcher.component';
import { ErrorNotifierService } from './services/error-notifier.service';

/**
 * Phase 27 — AppComponent shell.
 *
 * Renders a sticky top-level <app-menu> for all routes EXCEPT those whose
 * route data declares `hideMenu: true`. The /, /login, /register,
 * /forgot-password, /reset-password, /verify-email, and /admin-login
 * routes all carry that flag (see app.routes.ts), so the menu is correctly
 * hidden on every public surface while still adapting to new auth-only
 * routes automatically.
 *
 * Why a `data`-flag check instead of a hard-coded URL allowlist: the
 * route config is the single source of truth for "is this an auth route?";
 * any future auth-protected page (e.g. /settings, /billing) gets a menu
 * automatically with no AppComponent edit.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    TranslateModule,
    MenuComponent,
    ConfirmDialogComponent,
    LanguageSwitcherComponent
  ],
  template: `
    <app-menu *ngIf="(showMenu$ | async)"></app-menu>
    <!-- 2-8: menu-less public routes still need the EL/EN toggle. -->
    <app-language-switcher
      *ngIf="!(showMenu$ | async)"
      class="nl-language-float"
    ></app-language-switcher>
    <main
      class="nl-app-main"
      [class.has-menu]="(showMenu$ | async)"
    >
      <!-- Global unhandled-error banner: stays until dismissed, never reroutes. -->
      <div
        class="nl-error-banner"
        [class.nl-error-banner--public]="!(showMenu$ | async)"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        *ngIf="error$ | async"
      >
        <span class="nl-error-banner-text">{{ 'errors.unexpectedError' | translate }}</span>
        <button
          type="button"
          class="nl-error-banner-dismiss"
          (click)="dismissError()"
          [attr.aria-label]="'common.close' | translate"
        >{{ 'common.close' | translate }}</button>
      </div>
      <router-outlet></router-outlet>
    </main>
    <app-confirm-dialog></app-confirm-dialog>
  `,  // Phase 27 — zero per-component CSS. All visual surface lives in
  // src/styles.scss under .nl-app-main / .has-menu utility classes
  // (and the menu's own .nl-menu-* palette). The comment above
  // REPLACES the round-1 inline-docstring because that docstring
  // contained literal backticks (`anyComponentStyle: 4 kB`) inside a
  // backtick-delimited template literal, which caused the JS parser
  // to close the literal early and trigger TS2304 on `anyComponentStyle`
  // and `kB`. Keeping the visual intent — "we ship zero per-component
  // CSS so the anyComponentStyle budget is trivially honored" — but in
  // a form that is unambiguously NOT inside a template-literal region.
  styles: [] 
})
export class AppComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly errorNotifier = inject(ErrorNotifierService);

  public readonly error$ = this.errorNotifier.error$;

  /**
   * Live boolean stream: `true` iff the currently active deep child of the
   * route tree carries `hideMenu: true` in its data. Dataset to `false`
   * triggers the <app-menu> render + the .has-menu class on <main>.
   */
  public readonly showMenu$ = this.router.events.pipe(
    filter((event): event is NavigationEnd => event instanceof NavigationEnd),
    // Emit the current value immediately so the very first render isn't
    // delayed by one NavigationEnd (i.e., users see the menu on cold load
    // without a one-frame flash of "no menu").
    startWith(null),
    map(() => this.computeShowMenu())
  );

  ngOnInit(): void {
    // Take-until-destroyed via DestroyRef keeps the listener cleanup tight
    // to the component lifetime; Angular handles the unsubscribe on
    // app teardown via the destroyRef binding, no manual ngOnDestroy hook
    // needed. (Subscribe is a no-op here because showMenu$ already wires
    // itself up to Router events at field-init time, so we just kick the
    // pipeline into evaluating on first render.)
    this.showMenu$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  dismissError(): void {
    this.errorNotifier.dismiss();
  }

  /**
   * Walk the activated-route tree to the deepest child and inspect its
   * `data` map for `hideMenu`. Default: false (menu shows). Routes whose
   * data has `hideMenu: true` opt out.
   */
  private computeShowMenu(): boolean {
    let r = this.activatedRoute.snapshot;
    while (r.firstChild) {
      r = r.firstChild;
    }
    const hide = r.data && r.data['hideMenu'];
    return hide !== true;
  }
}
