/**
 * Production environment.
 *
 * `apiBaseUrl` stays empty on purpose: the app is served by nginx on the
 * same origin as the API, and nginx proxies `/api/` to the backend service
 * (see frontend/nginx.conf). Same-origin requests avoid CORS entirely and
 * work behind any hostname / reverse proxy without a rebuild.
 */
export const environment = {
  production: true,
  apiBaseUrl: '',
  // Empty disables client-error reporting. Set to an absolute URL or a
  // same-origin path (e.g. '/api/client-errors') to enable the POST.
  errorReportingUrl: '',
  // Empty disables Sentry; set at build time to enable error reporting.
  sentryDsn: '',
  sentryTracesSampleRate: 0
};
