import {
  EnvironmentProviders,
  Provider,
  importProvidersFrom
} from '@angular/core';
import {
  TranslateLoader,
  TranslateModule,
  TranslationObject
} from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import el from '../../assets/i18n/el.json';
import en from '../../assets/i18n/en.json';
import { AppLanguage, LANGUAGE_STORAGE_KEY } from './language.service';

/**
 * 2-8 (i18n): reusable TestBed providers.
 *
 * Loads the real translation files synchronously (no HTTP) so every
 * existing spec keeps asserting the rendered Greek copy under the default
 * `el` language. Add `provideTestTranslate()` to any TestBed that builds a
 * component using the `translate` pipe or `TranslateService`.
 */
export const EL_TRANSLATIONS = el as TranslationObject;
export const EN_TRANSLATIONS = en as TranslationObject;

export class InMemoryTranslateLoader extends TranslateLoader {
  override getTranslation(lang: string): Observable<TranslationObject> {
    return of(lang === 'en' ? EN_TRANSLATIONS : EL_TRANSLATIONS);
  }
}

export function provideTestTranslate(): Array<Provider | EnvironmentProviders> {
  return [
    importProvidersFrom(
      TranslateModule.forRoot({
        defaultLanguage: 'el',
        useDefaultLang: true,
        loader: {
          provide: TranslateLoader,
          useFactory: () => new InMemoryTranslateLoader()
        }
      })
    )
  ];
}

/** Dot-path lookup against the bundled dictionaries (for i18n specs). */
export function lookupTranslation(
  lang: AppLanguage,
  key: string
): string | undefined {
  const dict: Record<string, unknown> =
    lang === 'en'
      ? (EN_TRANSLATIONS as Record<string, unknown>)
      : (EL_TRANSLATIONS as Record<string, unknown>);
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Remove the persisted language so specs do not leak state into each other. */
export function resetLanguageStorage(): void {
  try {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    document.documentElement.lang = '';
  } catch {
    // localStorage may be unavailable; nothing to clean then.
  }
}
