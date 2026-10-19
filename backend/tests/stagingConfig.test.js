// 3-2: dependency-free validation of the staging/TLS/secrets configuration.
//
// The compose and Traefik files are validated as text so this suite works
// without a YAML parser. When js-yaml happens to be present (it is a
// transitive Jest dependency in this repository) we additionally parse the
// documents and assert their structure. The test never requires it.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

let yaml = null;
try {
  // Deliberately optional: production images install only backend deps.
  yaml = require('js-yaml');
} catch (_) {
  yaml = null;
}

function parseYaml(text) {
  if (!yaml) return null;
  const load = typeof yaml.safeLoad === 'function' ? yaml.safeLoad : yaml.load;
  return load(text);
}

/**
 * Extract one top-level compose service block as text. The fallback parser
 * below is intentionally simple: service keys are exactly two spaces deep.
 */
function serviceBlock(compose, name) {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return '';

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break; // volumes:, networks:, x-...
    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(line)) break; // next service
    body.push(line);
  }
  return body.join('\n');
}

const compose = read('docker-compose.staging.yml');
const envExample = read('.env.staging.example');
const docs = read('docs/staging-deployment.md');
const traefikConfig = read('deploy/traefik/traefik.yml');

const CORE_SERVICES = [
  'db',
  'redis',
  'ollama',
  'whisper',
  'backend',
  'frontend',
  'traefik',
  'backup',
  'retention'
];
const MONITORING_SERVICES = ['prometheus', 'grafana', 'redis_exporter', 'node_exporter'];

describe('staging stack configuration (3-2)', () => {
  it('defines the production-like services and only Traefik publishes 80/443', () => {
    for (const service of [...CORE_SERVICES, ...MONITORING_SERVICES]) {
      expect(compose).toMatch(new RegExp(`^  ${service}:$`, 'm'));
    }

    const traefik = serviceBlock(compose, 'traefik');
    expect(traefik).toMatch(/^\s{4}ports:/m);
    expect(traefik).toContain('${STAGING_HTTP_PORT:-80}:80');
    expect(traefik).toContain('${STAGING_HTTPS_PORT:-443}:443');

    // The application and data services must never publish a host port.
    for (const service of ['db', 'redis', 'ollama', 'whisper', 'backend', 'frontend', 'backup', 'retention']) {
      expect(serviceBlock(compose, service)).not.toMatch(/^\s{4}ports:/m);
    }

    // Grafana is profile-gated and loopback-only; Prometheus is never public.
    expect(serviceBlock(compose, 'grafana')).toContain('127.0.0.1:${GRAFANA_PORT:-3001}:3000');
    expect(compose).not.toMatch(/^\s*-\s*"?9090:9090"?\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?3000:3000"?\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?5432:5432"?\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?6379:6379"?\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?11434:11434"?\s*$/m);
    expect(compose).not.toMatch(/^\s*-\s*"?8000:8000"?\s*$/m);
  });

  it('parses as YAML and keeps the expected service/port structure', () => {
    const doc = parseYaml(compose);
    if (!doc) {
      // Text fallback: the port assertions above already cover the invariant.
      expect(compose).toMatch(/^services:/m);
      return;
    }

    expect(doc.name).toBe('nomosai-staging');
    expect(doc.services).toBeDefined();

    for (const service of [...CORE_SERVICES, ...MONITORING_SERVICES]) {
      expect(doc.services[service]).toBeDefined();
    }

    expect(doc.services.traefik.ports).toEqual(
      expect.arrayContaining([
        '${STAGING_HTTP_PORT:-80}:80',
        '${STAGING_HTTPS_PORT:-443}:443'
      ])
    );

    for (const service of ['db', 'redis', 'ollama', 'whisper', 'backend', 'frontend', 'backup', 'retention']) {
      expect(doc.services[service].ports).toBeUndefined();
    }

    expect(doc.services.prometheus.ports).toBeUndefined();
    expect(doc.services.grafana.ports).toEqual(['127.0.0.1:${GRAFANA_PORT:-3001}:3000']);

    for (const service of CORE_SERVICES) {
      expect(doc.services[service].restart).toBe('unless-stopped');
    }

    for (const volume of [
      'pgdata_staging',
      'redisdata_staging',
      'ollama_models_staging',
      'whisper_cache_staging',
      'traefik_certs',
      'backups_staging'
    ]) {
      expect(doc.volumes[volume]).toBeDefined();
    }

    expect(doc.networks['nomos-staging-network']).toMatchObject({
      name: 'nomos-staging-network',
      driver: 'bridge'
    });
  });

  it('configures Traefik TLS, ACME, the Docker provider, and an HTTP→HTTPS redirect', () => {
    // Static config.
    expect(traefikConfig).toMatch(/entryPoints:/);
    expect(traefikConfig).toMatch(/address:\s*":80"/);
    expect(traefikConfig).toMatch(/address:\s*":443"/);
    expect(traefikConfig).toMatch(/to:\s*websecure/);
    expect(traefikConfig).toMatch(/scheme:\s*https/);
    expect(traefikConfig).toMatch(/permanent:\s*true/);
    expect(traefikConfig).toMatch(/exposedByDefault:\s*false/);
    expect(traefikConfig).toContain('network: "nomos-staging-network"');
    expect(traefikConfig).toContain('unix:///var/run/docker.sock');

    const staticDoc = parseYaml(traefikConfig);
    if (staticDoc) {
      expect(staticDoc.entryPoints.web.address).toBe(':80');
      expect(staticDoc.entryPoints.websecure.address).toBe(':443');
      expect(
        staticDoc.entryPoints.web.http.redirections.entryPoint
      ).toMatchObject({ to: 'websecure', scheme: 'https', permanent: true });
      expect(staticDoc.providers.docker.exposedByDefault).toBe(false);
      expect(staticDoc.providers.docker.network).toBe('nomos-staging-network');
    }

    // ACME + certificate storage + Docker socket in compose.
    const traefik = serviceBlock(compose, 'traefik');
    expect(traefik).toContain('--configFile=/etc/traefik/traefik.yml');
    expect(traefik).toContain('certificatesresolvers.le.acme.email=${ACME_EMAIL');
    expect(traefik).toContain('acme.storage=/letsencrypt/acme.json');
    expect(traefik).toContain(
      'acme.caserver=${STAGING_ACME_CA:-https://acme-staging-v02.api.letsencrypt.org/directory}'
    );
    expect(traefik).toContain('acme.httpchallenge=true');
    expect(traefik).toContain('acme.httpchallenge.entrypoint=web');
    expect(traefik).toContain('/var/run/docker.sock:/var/run/docker.sock:ro');
    expect(traefik).toContain('traefik_certs:/letsencrypt');

    // The public router lives on the frontend container, not on Traefik.
    const frontend = serviceBlock(compose, 'frontend');
    expect(frontend).toContain('traefik.enable=true');
    expect(frontend).toContain('traefik.docker.network=nomos-staging-network');
    expect(frontend).toContain(
      'traefik.http.routers.nomos-staging.rule=Host(`${STAGING_DOMAIN'
    );
    expect(frontend).toContain('traefik.http.routers.nomos-staging.entrypoints=websecure');
    expect(frontend).toContain('traefik.http.routers.nomos-staging.tls=true');
    expect(frontend).toContain('traefik.http.routers.nomos-staging.tls.certresolver=le');
    expect(frontend).toContain('traefik.http.services.nomos-staging.loadbalancer.server.port=80');
    expect(frontend).not.toContain('loadbalancer.server.port=3000');
  });

  it('mirrors the required production backend environment with staging values', () => {
    const backend = serviceBlock(compose, 'backend');

    for (const env of [
      'NODE_ENV=production',
      'DB_HOST=db',
      'DB_PORT=5432',
      'DB_USER=nomos_admin',
      'DB_PASSWORD=${DB_PASSWORD',
      'DB_NAME=nomos_db',
      'REDIS_URL=redis://redis:6379',
      'OLLAMA_URL=http://ollama:11434',
      'OLLAMA_EMBED_MODEL=bge-m3',
      'OLLAMA_EMBED_DIM=1024',
      'OLLAMA_CHAT_MODEL=gemma2b-mmap',
      'WHISPER_URL=http://whisper:8000',
      'STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID_BASIC=${STRIPE_PRICE_ID_BASIC',
      'STRIPE_PRICE_ID_PRO=${STRIPE_PRICE_ID_PRO',
      'STRIPE_PRICE_ID_ENTERPRISE=${STRIPE_PRICE_ID_ENTERPRISE',
      'STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET',
      'JWT_SECRET=${JWT_SECRET',
      'APP_BASE_URL=https://${STAGING_DOMAIN}',
      'CORS_ORIGINS=https://${STAGING_DOMAIN}',
      'EMAIL_TRANSPORT=smtp',
      'EMAIL_FROM=${EMAIL_FROM',
      'SMTP_HOST=${SMTP_HOST',
      'SMTP_PORT=${SMTP_PORT:-587}',
      'TRUST_PROXY=uniquelocal,loopback',
      'RETENTION_CONVERSATIONS_DAYS=',
      'RETENTION_DOCUMENTS_DAYS=',
      'RETENTION_AUDIT_LOG_DAYS=',
      'SCRAPED_LAWS_PATH=/usr/src/app/scraped_laws.json'
    ]) {
      expect(backend).toContain(env);
    }

    expect(backend).not.toContain('NODE_ENV=development');
    expect(backend).not.toContain('EMAIL_TRANSPORT=console');
    expect(backend).toContain('depends_on:');
    expect(backend).toContain('condition: service_healthy');
  });

  it('gives core services healthchecks and named volumes', () => {
    for (const service of ['db', 'redis', 'ollama', 'whisper', 'backend', 'frontend', 'traefik']) {
      expect(serviceBlock(compose, service)).toMatch(/healthcheck:/);
    }

    for (const volume of [
      'pgdata_staging',
      'redisdata_staging',
      'ollama_models_staging',
      'whisper_cache_staging',
      'traefik_certs',
      'backups_staging'
    ]) {
      expect(compose).toMatch(new RegExp(`^  ${volume}:$`, 'm'));
    }

    expect(serviceBlock(compose, 'db')).toContain('pgdata_staging:/var/lib/postgresql/data');
    expect(serviceBlock(compose, 'redis')).toContain('redisdata_staging:/data');
    expect(serviceBlock(compose, 'ollama')).toContain('ollama_models_staging:/root/.ollama');
    expect(serviceBlock(compose, 'whisper')).toContain(
      'whisper_cache_staging:/home/ubuntu/.cache/huggingface/hub'
    );
  });

  it('reuses monitoring/ behind the optional monitoring profile', () => {
    for (const service of MONITORING_SERVICES) {
      expect(serviceBlock(compose, service)).toContain('profiles: ["monitoring"]');
    }

    expect(serviceBlock(compose, 'prometheus')).toContain(
      './monitoring/prometheus:/etc/prometheus:ro'
    );
    expect(serviceBlock(compose, 'grafana')).toContain(
      './monitoring/grafana/provisioning:/etc/grafana/provisioning:ro'
    );
    expect(serviceBlock(compose, 'grafana')).toContain(
      './monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro'
    );
    expect(serviceBlock(compose, 'node_exporter')).toContain(
      'prom_textfile_staging:/prom-textfile:ro'
    );
    expect(serviceBlock(compose, 'prometheus')).not.toContain('ports:');
  });

  it('documents every required secret as a dummy placeholder in the env example', () => {
    for (const key of [
      'STAGING_DOMAIN',
      'ACME_EMAIL',
      'STAGING_ACME_CA',
      'DB_PASSWORD',
      'JWT_SECRET',
      'EMAIL_FROM',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURE',
      'SMTP_USER',
      'SMTP_PASS',
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID_BASIC',
      'STRIPE_PRICE_ID_PRO',
      'STRIPE_PRICE_ID_ENTERPRISE',
      'STRIPE_WEBHOOK_SECRET',
      'GRAFANA_ADMIN_PASSWORD',
      'RETENTION_CONVERSATIONS_DAYS',
      'RETENTION_DOCUMENTS_DAYS',
      'RETENTION_AUDIT_LOG_DAYS'
    ]) {
      expect(envExample).toMatch(new RegExp(`^${key}=`, 'm'));
    }

    // Example values must be obviously fake and must never be live keys.
    expect(envExample).toContain('REPLACE_WITH');
    expect(envExample).toContain('sk_test_');
    expect(envExample).not.toMatch(/sk_live_[A-Za-z0-9]/);
    expect(envExample).not.toMatch(/whsec_[A-Za-z0-9]{20,}/);
    expect(envExample).toContain('chmod 600');
    expect(envExample).toContain('.env.staging');
    expect(envExample).toContain('NEVER use sk_live_');
    expect(envExample).toContain('config -q');
  });

  it('documents the TLS, secrets, rotation, migration, rollback, and restore runbook', () => {
    for (const text of [
      'Traefik',
      "Let's Encrypt",
      'acme-staging-v02.api.letsencrypt.org',
      'STAGING_ACME_CA',
      'self-signed',
      'redirects to HTTPS',
      'HSTS',
      'rate limit',
      '.env.staging',
      'chmod 600',
      'Docker secrets',
      'Vault/OpenBao',
      '_FILE',
      'Rotation',
      'JWT_SECRET',
      'token_version',
      'STRIPE_WEBHOOK_SECRET',
      'SMTP',
      'DB_PASSWORD',
      'backup-restore.md',
      'exec backend npm run migrate',
      'up -d --build',
      'rollback',
      'Smoke checklist',
      'register',
      'webhook',
      'GDPR',
      'Stripe'
    ]) {
      expect(docs.toLowerCase()).toContain(text.toLowerCase());
    }

    // The rate-limit caveat must explicitly say the staging CA is the default.
    expect(docs).toMatch(/staging CA/i);
    expect(docs).toMatch(/not trusted/i);
    // Docker-secret documentation now reflects the implemented `*_FILE`
    // resolution (file precedence, supported secret list).
    expect(docs).toMatch(/\*_FILE|`_FILE`/);
    expect(docs).toMatch(/takes precedence/i);
    expect(docs).toMatch(/JWT_SECRET_FILE/);
    expect(docs).not.toMatch(/does\s+\*{0,2}not\*{0,2}\s+implement/i);
    // The runbook must link the backup/restore procedure.
    expect(docs).toMatch(/\[.*\]\(backup-restore\.md\)/);
  });
});
