import {
  APP_INITIALIZER,
  ApplicationConfig,
  LOCALE_ID,
  importProvidersFrom
} from '@angular/core';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { registerLocaleData } from '@angular/common';
import localeEl from '@angular/common/locales/el';
import { provideRouter, TitleStrategy, withInMemoryScrolling } from '@angular/router';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
import { routes } from './app.routes';
import { LanguageService } from './i18n/language.service';
import { TranslatedTitleStrategy } from './i18n/translated-title.strategy';

// 2-8 (i18n): Greek-first locale data for the date/number/currency pipes.
// Angular 17 cannot swap LOCALE_ID at runtime without recreating the root
// injector, so pipes keep `el-GR` formatting even when the UI language is
// switched to English (documented in the 2-8 report; no per-component hacks).
registerLocaleData(localeEl);

/** Loads `assets/i18n/{{lang}}.json` over HTTP. */
export function translateHttpLoaderFactory(
  http: HttpClient
): TranslateHttpLoader {
  return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

/** Restore the persisted language (default `el`) before first render. */
export function initLanguageFactory(language: LanguageService): () => Promise<void> {
  return () => language.init();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(
      routes,
      // 2-7: every navigation starts at the top of the page unless the URL
      // targets an in-page anchor (#section). This also restores the scroll
      // position when navigating back through history.
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'enabled'
      })
    ),
    // 2-8 (i18n): the HTTP loader needs HttpClient (the dead auth
    // interceptor was already removed in 2-10, so this is a plain client).
    provideHttpClient(),
    importProvidersFrom(
      TranslateModule.forRoot({
        defaultLanguage: 'el',
        // Missing keys fall back to the default dictionary; both bundled
        // dictionaries are key-identical (pinned by i18n.spec.ts) so this
        // only ever masks a deploy skew.
        useDefaultLang: true,
        loader: {
          provide: TranslateLoader,
          useFactory: translateHttpLoaderFactory,
          deps: [HttpClient]
        }
      })
    ),
    {
      provide: APP_INITIALIZER,
      useFactory: initLanguageFactory,
      deps: [LanguageService],
      multi: true
    },
    { provide: LOCALE_ID, useValue: 'el-GR' },
    // 2-8 (i18n): tab titles resolve `data.titleKey` per language.
    { provide: TitleStrategy, useClass: TranslatedTitleStrategy }
  ]
};
