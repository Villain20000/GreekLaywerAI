# Cloudflare edge setup

Cloudflare is optional but recommended for production. The in-repo pieces are
limited to application-side defenses:

- Traefik rate limiting and in-flight request limits on the public HTTPS
  router (`docker-compose.prod.yml` / `docker-compose.staging.yml`).
- `deploy/cloudflare/real-ip.conf`, mounted into the frontend nginx container
  so `$remote_addr` (and the `X-Real-IP` forwarded to the backend) reflects the
  client instead of a Cloudflare edge IP.
- Backend per-user/IP rate limits, quotas and JWT auth.

**WAF managed rules, rate-limiting rules, cache rules, bot management and DDoS
mitigation are account-side controls. They cannot be configured in this
repository.** This document describes the settings to apply in the Cloudflare
dashboard; verify them against current Cloudflare plan limits.

## Proxy and TLS

1. Add the public hostname as an `A` (and `AAAA`, if used) record pointing at
   the origin, proxied (orange cloud).
2. SSL/TLS mode: **Full (strict)**. Use a Cloudflare Origin CA certificate on
   Traefik, or keep Let's Encrypt and complete HTTP-01 with the record
   DNS-only before switching the proxy on.
3. Enable **Always Use HTTPS** and a minimum TLS version (1.2 or 1.3).
4. Add HSTS only after the certificate path is proven; the application does
   not set HSTS by default.
5. Restrict origin ingress (host firewall/security group) to Cloudflare's
   published ranges (`https://www.cloudflare.com/ips/`). Otherwise clients can
   bypass the proxy and spoof forwarding headers.

## Real client IP

The compose stacks mount `real-ip.conf` at
`/etc/nginx/cloudflare/real-ip.conf`; `frontend/nginx.conf` includes that
directory. The file sets `real_ip_header CF-Connecting-IP` and
`real_ip_recursive on`, and trusts only the published Cloudflare ranges by
default.

In the bundled chain (Cloudflare -> Traefik -> nginx) nginx's immediate peer is
Traefik. To make `CF-Connecting-IP` effective there, uncomment the private
range block at the bottom of `real-ip.conf` **and** ensure the origin only
accepts Cloudflare traffic. Without that, nginx keeps seeing Traefik's address.

Refresh the ranges when Cloudflare changes them:

```bash
curl -fsS https://www.cloudflare.com/ips-v4
curl -fsS https://www.cloudflare.com/ips-v6
# Update deploy/cloudflare/real-ip.conf, then rebuild/recreate the frontend.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --build --force-recreate frontend
```

The wildcard include is optional, so direct traffic and deployments without
Cloudflare keep working.

## WAF managed rules

Enable the Cloudflare Managed Ruleset and the OWASP Core Ruleset under
**Security -> WAF**. Start in log/simulate mode, review false positives for
the Angular SPA and the API, then enforce. Pay attention to:

- request-body limits for document uploads (25 MB backend cap),
- JSON and multipart uploads under `/api/documents` and `/api/ai/*`,
- Stripe webhook traffic (`POST /api/billing/webhook`) — allow Stripe rather
  than challenging it,
- long-lived SSE requests (`GET /api/ai/query/live/:jobId/events`) — do not
  apply aggressive request-duration rules.

## Rate-limiting rules

Account-side rules complement the Traefik limiter. Example policy (tune to
your traffic and plan):

| Path | Suggested rule |
| --- | --- |
| `/api/auth/*` | ~20 requests/minute per IP, managed challenge above it |
| `/api/ai/*` | ~30 requests/minute per IP; SSE requests count as one |
| `/api/billing/webhook` | allow Stripe; do not rate-limit retries |
| `/*` (static) | high threshold or cache-served, so normal page loads pass |
| `/health`, `/healthz`, `/metrics` | block or allow only your monitors |

The in-repo limits are `EDGE_RATE_LIMIT_AVERAGE` (requests/second, default 50),
`EDGE_RATE_LIMIT_BURST` (default 100) and `EDGE_INFLIGHT_REQ_AMOUNT`
(concurrent requests, default 100). They are per-request: a long SSE response
consumes one request slot, not one slot per second.

## Cache rules

Cloudflare caches static assets at the edge by default. Add explicit rules:

1. **Bypass cache** for `/api/*` (including SSE), `/health`, `/healthz`,
   `/metrics`, `/ngsw-worker.js`, `/ngsw.json`, `/index.html`, `/sitemap.xml`
   and `/robots.txt`.
2. **Cache eligible static assets** (`/assets/*` plus content-hashed
   `*.js`, `*.css`, fonts and images) with a long Edge TTL. Browser TTL should
   follow the origin headers: hashed assets are `immutable`, HTML is
   `no-store`.
3. Do not enable "Cache Everything" for the SPA shell: new deployments must
   pick up a new `index.html` immediately.

## DDoS and bots

L3/L4 DDoS protection is automatic on proxied records. Enable the L7 managed
ruleset and bot fight mode where your plan provides it, then watch the
analytics for challenge rates on the API. These are account-side features; the
repository only ships application rate limits, quotas and authentication.

## SSE and WebSockets

Cloudflare proxies HTTP/2 and WebSockets. SSE responses should emit data or
heartbeats well inside Cloudflare's origin read timeout (100 seconds by
default for proxied HTTP); the application already streams tokens as they are
produced. If you add a longer idle path, send periodic comment lines.

## Verify

```bash
# Origin should return 200 only through the proxy when ingress is restricted.
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/healthz

# Real-IP recovery: nginx access logs / X-Real-IP should show the client IP.
docker compose -f docker-compose.prod.yml --env-file .env.production \
  logs --tail=50 frontend
```

Cloudflare's **Security Events** and **Analytics** views are the source of
truth for WAF/rate-limit actions; they are not exported into the local
Prometheus stack.
