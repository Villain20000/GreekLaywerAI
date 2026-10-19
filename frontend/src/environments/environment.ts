/**
 * Same-origin relative URL.
 *
 * The Angular dev server runs with `--proxy-config proxy.conf.json`, which
 * forwards every `/api/*` request from the browser to the `backend` service
 * in docker-compose. From the browser's point of view all API calls hit
 * the same origin as the page (e.g. `http://localhost:4200/api/auth/login`
 * or `https://<codespace>-4200.app.github.dev/api/auth/login`), which means:
 *
 *   - No CORS preflight
 *   - No mixed-content (HTTP/HTTPS) surprises
 *   - No port-forwarding dance: only the frontend port (4200) needs to be
 *     exposed to the user's browser, in any environment
 *     (localhost, devcontainer, GitHub Codespaces, Gitpod, …)
 *
 * `apiBaseUrl` stays an empty string so the existing service code keeps
 * its template-literal shape (`${environment.apiBaseUrl}/api/auth`).
 */
export const environment = {
  production: false,
  apiBaseUrl: '',
  // Empty disables client-error reporting. Set to an absolute URL or a
  // same-origin path (e.g. '/api/client-errors') to enable the POST.
  errorReportingUrl: '',
  // Empty disables Sentry; set at build time to enable error reporting.
  sentryDsn: '',
  sentryTracesSampleRate: 0
};
