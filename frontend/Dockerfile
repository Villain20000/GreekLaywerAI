# syntax=docker/dockerfile:1

# ── Stage 1: build the Angular application ──────────────────────────────
# Dev dependencies (Angular CLI, compiler, esbuild, …) are required to
# build, so NODE_ENV must NOT be set to production here.
FROM node:20-alpine AS build

WORKDIR /app

# Chrome is only needed by Karma (unit tests), which does not run in the
# image — skip the ~150 MB puppeteer browser download.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NG_CLI_ANALYTICS=false \
    CI=true

# Public origin baked into index.html, sitemap.xml and robots.txt.
ARG SITE_URL=https://your-domain.gr
ENV SITE_URL=$SITE_URL

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Angular 17 application builder output: dist/<project>/browser. The build
# script also runs scripts/apply-site-url.js.
RUN npm run build

# ── Stage 2: serve the static bundle with nginx ─────────────────────────
FROM nginx:1.27-alpine AS runtime

# The include directory is always present so the wildcard include in
# nginx.conf is valid; the compose stacks mount deploy/cloudflare/real-ip.conf
# into it (the file lives outside this build context).
RUN mkdir -p /etc/nginx/cloudflare
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/nomos-ai-frontend/browser /usr/share/nginx/html

EXPOSE 80 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
