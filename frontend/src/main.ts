import * as Sentry from '@sentry/browser';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { environment } from './environments/environment';

if (environment.sentryDsn) {
  try {
    // @sentry/browser v11 moved this option out of its typings; keep passing
    // it for SDK versions that still honor the explicit PII opt-out.
    const options = {
      dsn: environment.sentryDsn,
      environment: environment.production ? 'production' : 'development',
      tracesSampleRate: environment.sentryTracesSampleRate ?? 0,
      sendDefaultPii: false
    } as Sentry.BrowserOptions;

    Sentry.init(options);
  } catch (err) {
    console.error('[sentry] initialization failed', err);
  }
}

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
