# Kubernetes deployment (multi-host baseline)

The single-host Docker Compose stacks remain the default deployment. These
manifests are a deployable baseline for operators who need more than one host
or want to run the stateless application tier on Kubernetes.

Scope:

- `nomosai-backend` Deployment (2 replicas, rolling updates, HPA 2-6 pods);
  web replicas run with `QUEUE_WORKER_ENABLED=false`
- `nomosai-worker` Deployment (exactly 1 replica) consuming the BullMQ queue,
  so GPU inference concurrency stays 1 across every web replica
- `nomosai-frontend` Deployment (2 replicas) serving the SPA and proxying
  `/api/` to the `backend` Service
- ClusterIP Services, Ingress and a shared ConfigMap/Secret
- No PostgreSQL, Redis, Ollama or whisper workloads: use managed/external
  endpoints (PostgreSQL with pgvector, Redis, an Ollama service). The backend
  image does not include those runtimes.

The `backend` Service is intentionally named `backend` because
`frontend/nginx.conf` proxies to `http://backend:3000`.

## Prerequisites

- Kubernetes 1.25+ and `kubectl`
- An ingress controller (manifests assume ingress-nginx)
- `metrics-server` for the HPA
- A default StorageClass only if you add your own stateful workloads; this
  baseline requests no persistent volumes
- cert-manager (optional) or a pre-created TLS Secret for `app.example.com`
- Images pushed to a registry reachable by the cluster

## Build and push images

```bash
TAG=2026-10-19
REGISTRY=registry.example.com/nomosai

docker build -t "$REGISTRY/backend:$TAG" ./backend
docker build \
  --build-arg SITE_URL=https://app.example.com \
  -t "$REGISTRY/frontend:$TAG" ./frontend

docker push "$REGISTRY/backend:$TAG"
docker push "$REGISTRY/frontend:$TAG"
```

`SITE_URL` is baked into `index.html`, `sitemap.xml` and `robots.txt` at build
time, so build one frontend image per public origin. Use immutable tags (not
`latest`) for rollbacks. If the registry is private, create an image pull
secret in the `nomosai` namespace and reference it from both Deployments.

Update `image:` in `deploy/k8s/backend.yaml` and `deploy/k8s/frontend.yaml`,
and set the hostname in `deploy/k8s/ingress.yaml` / `configmap.yaml`.

## Configure

1. Edit `deploy/k8s/configmap.yaml`:
   - `DB_HOST`, `REDIS_URL`, `OLLAMA_URL`, `WHISPER_URL` (private endpoints),
   - `APP_BASE_URL` / `CORS_ORIGINS`,
   - SMTP, Stripe price IDs, quotas, OCR, retention, Sentry and A/B settings.
2. Create the Secret from `deploy/k8s/secret.example.yaml`, replacing every
   placeholder. Do not commit the filled-in file:

   ```bash
   cp deploy/k8s/secret.example.yaml /tmp/nomosai-secret.yaml
   $EDITOR /tmp/nomosai-secret.yaml
   kubectl apply -f /tmp/nomosai-secret.yaml
   ```

   Or create it imperatively:

   ```bash
   kubectl -n nomosai create secret generic nomosai-secrets \
     --from-literal=DB_PASSWORD='...' \
     --from-literal=JWT_SECRET="$(openssl rand -hex 64)" \
     --from-literal=STRIPE_SECRET_KEY='<live key>' \
     --from-literal=STRIPE_WEBHOOK_SECRET='<signing secret>'
   ```

   `SMTP_USER`, `SMTP_PASS` and `SENTRY_DSN` are optional; omit them from the
   Secret if unused (the Deployment marks them optional).
3. If cert-manager is not installed, create the `nomosai-tls` Secret in the
   `nomosai` namespace with the certificate/key for the Ingress host.

The backend does not currently support TLS parameters for PostgreSQL; expose a
managed database over a private network or a sidecar/proxy that terminates TLS
locally. Keep `TRUST_PROXY` aligned with the ingress/nginx hop addresses if
your pod or node CIDR is not covered by `uniquelocal,loopback`.

## Deploy

```bash
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/backend.yaml
kubectl apply -f deploy/k8s/frontend.yaml
kubectl apply -f deploy/k8s/ingress.yaml

kubectl -n nomosai rollout status deploy/nomosai-backend
kubectl -n nomosai rollout status deploy/nomosai-frontend
kubectl -n nomosai get pods,svc,ingress,hpa
```

Run migrations once per release against the external database:

```bash
kubectl -n nomosai exec deploy/nomosai-backend -- \
  node /usr/src/app/src/scripts/migrate-all.js
```

The container runs as UID 1000 from `/tmp`; scripts must use absolute paths.

## Stripe webhook

Register the endpoint from inside the cluster (or locally with the same env):

```bash
kubectl -n nomosai exec deploy/nomosai-backend -- \
  node /usr/src/app/src/scripts/configure-stripe-webhook.js --dry-run
kubectl -n nomosai exec deploy/nomosai-backend -- \
  node /usr/src/app/src/scripts/configure-stripe-webhook.js
```

On creation, the script prints the signing secret once. Store it in the
`nomosai-secrets` Secret as `STRIPE_WEBHOOK_SECRET` and restart the backend
Deployment. Creating an endpoint requires `APP_BASE_URL` to be the public
HTTPS origin.

## Operations

- **Rolling updates**: `maxUnavailable: 0` with readiness probes. The backend
  deployment drains connections on SIGTERM (30 s grace period).
- **Probes**: readiness/startup use `/health` (503 while PostgreSQL or Redis is
  down); liveness is a TCP check so an external outage does not restart every
  pod. The frontend uses `/healthz`.
- **Scaling**: the HPA needs metrics-server. Each backend pod opens its own
  PostgreSQL pool (default 10 connections); size the database for
  `maxReplicas × pool` connections and set Redis/Ollama limits accordingly.
- **Backups/retention**: not part of this baseline. Use managed PostgreSQL
  snapshots/backups and run `node /usr/src/app/src/scripts/retentionCleanup.js`
  from a CronJob (or equivalent). The compose stacks ship dedicated cron
  sidecars.
- **Observability**: `/metrics` and `/health` are exposed by the backend
  Service. The in-repo Prometheus config scrapes Compose DNS names, so add a
  ServiceMonitor/PodMonitor or scrape annotations for your cluster Prometheus.
  See [../../docs/observability.md](../../docs/observability.md).
- **Edge protection**: rate limiting lives at the ingress/Cloudflare layer in
  this topology. Cloudflare account setup and nginx real-IP guidance:
  [../cloudflare/README.md](../cloudflare/README.md).
- **Frontend real-IP**: to trust `CF-Connecting-IP`, create a ConfigMap from
  `deploy/cloudflare/real-ip.conf` and uncomment the mount in
  `frontend.yaml`:

  ```bash
  kubectl -n nomosai create configmap cloudflare-real-ip \
    --from-file=real-ip.conf=deploy/cloudflare/real-ip.conf
  ```

## Limitations

- External PostgreSQL/Redis/Ollama are required; there is no stateful stack
  here.
- No backup/retention CronJobs, NetworkPolicies or PodDisruptionBudgets are
  shipped. Add them for a production cluster.
- The Compose stack (with its backup, retention and monitoring sidecars) is
  still the reference single-host deployment:
  [../../docs/production-hardening.md](../../docs/production-hardening.md).
