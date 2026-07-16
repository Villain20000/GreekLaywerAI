import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

/**
 * Phase 27 — ThemeService.
 *
 * Owns the `<html data-theme="…">` attribute that drives every CSS custom
 * property in `src/styles.scss`. Persists the user's choice to
 * `localStorage.nomos_theme` so a cold start on the same browser keeps the
 * same surface; if no choice is stored, the OS `prefers-color-scheme` is
 * honoured (also applied by the inline bootstrap <script> in
 * `src/index.html`, which runs BEFORE Angular evaluates — so there's no
 * flash of wrong theme on first paint).
 *
 * Why a service and not just a CSS toggle:
 *   - The `<html data-theme>` attribute is the API, but services are how
 *     Angular components READ the current value (e.g. the menu's sun/moon
 *     icon needs to know which surface it's on to render the right glyph).
 *   - `toggle()` is idempotent in the sense that spin-and-back gives the
 *     same end state, but we still re-apply the attribute even when the
 *     value is unchanged so external listeners (rare) keep their
 *     consistency.
 */
export type ThemeName = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly STORAGE_KEY = 'nomos_theme';
  /** Default surface for first-time visitors with no stored preference. */
  private static readonly DEFAULT_THEME: ThemeName = 'dark';

  private readonly subject = new BehaviorSubject<ThemeName>(
    ThemeService.DEFAULT_THEME
  );
  /** Live observable for any component that needs to react to toggles. */
  public readonly theme$: Observable<ThemeName> = this.subject.asObservable();

  constructor() {
    // The bootstrap <script> in index.html has already set the attribute
    // synchronously before Angular booted, so this should always find a
    // valid value. We defensively fall back to the default if for any
    // reason it didn't (SSR, private mode, attribute stripped by an
    // extension, etc.) so the rest of the UI never sees `undefined`.
    this.subject.next(this.readCurrentAttribute());
  }

  /** Synchronous getter for templates that want to render without async pipe. */
  public get current(): ThemeName {
    return this.subject.value;
  }

  /** Flip the surface. Persists to localStorage so the next cold start matches. */
  public toggle(): void {
    this.set(this.current === 'dark' ? 'light' : 'dark');
  }

  /** Set a specific theme. Persists to localStorage. */
  public set(theme: ThemeName): void {
    this.subject.next(theme);
    try {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem(ThemeService.STORAGE_KEY, theme);
    } catch (_e) {
      // SSR / private-mode browsers / etc. The subject still updates for any
      // in-session subscribers; the choice just won't persist across reloads.
    }
  }

  /**
   * Read `<html data-theme>`, defending against an absent or stale value.
   * Called once in the constructor; subsequent mutations are driven by
   * `toggle()` / `set()`.
   */
  private readCurrentAttribute(): ThemeName {
    try {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark' || attr === 'light') {
        return attr;
      }
    } catch (_e) {
      // `document` may be unavailable in pre-boot or test environments;
      // fall through to the default.
    }
    return ThemeService.DEFAULT_THEME;
  }
}
