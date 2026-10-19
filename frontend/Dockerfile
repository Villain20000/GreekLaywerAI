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

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Angular 17 application builder output: dist/<project>/browser
RUN npx ng build --configuration production

# ── Stage 2: serve the static bundle with nginx ─────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/nomos-ai-frontend/browser /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
