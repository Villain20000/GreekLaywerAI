import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';

/** Languages shipped in `src/assets/i18n/*.json`. Greek is the default. */
export type AppLanguage = 'el' | 'en';

export const SUPPORTED_LANGUAGES: readonly AppLanguage[] = ['el', 'en'];

/** localStorage key used to persist the user's language choice. */
export const LANGUAGE_STORAGE_KEY = 'nomos_lang';

export const DEFAULT_LANGUAGE: AppLanguage = 'el';

/**
 * 2-8 (i18n): runtime language switching.
 *
 * Wraps `TranslateService.use()` so every switch also:
 *   - updates `<html lang>` (a11y / spell-check),
 *   - persists the choice in localStorage (`nomos_lang`), and
 *   - exposes the active language as a signal for the EL/EN switcher.
 *
 * The service is initialised once via APP_INITIALIZER in `app.config.ts`,
 * before the first route renders, so translations are available on cold
 * load and on logged-out pages too.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly translate = inject(TranslateService);
  private readonly document = inject(DOCUMENT);

  /** Active language; `el` until `init()` restores a persisted choice. */
  public readonly current = signal<AppLanguage>(DEFAULT_LANGUAGE);

  /** Apply the stored language (or Greek) on cold start. */
  public async init(): Promise<void> {
    await this.apply(this.readStored() ?? DEFAULT_LANGUAGE);
  }

  /** Switch language and remember the choice. */
  public async setLanguage(lang: AppLanguage): Promise<void> {
    await this.apply(lang);
    this.persist(lang);
  }

  /** Flip between Greek and English. */
  public async toggle(): Promise<void> {
    await this.setLanguage(this.current() === 'el' ? 'en' : 'el');
  }

  private async apply(lang: AppLanguage): Promise<void> {
    this.current.set(lang);
    this.document.documentElement.lang = lang;
    try {
      await firstValueFrom(this.translate.use(lang));
    } catch {
      // Loading failure must not break the app shell; TranslatePipe will
      // keep rendering keys until the dictionary arrives.
    }
  }

  private readStored(): AppLanguage | null {
    try {
      const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return stored === 'el' || stored === 'en' ? stored : null;
    } catch {
      return null;
    }
  }

  private persist(lang: AppLanguage): void {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // Private-mode browsers may reject writes; the in-memory choice
      // still applies for the current session.
    }
  }
}
