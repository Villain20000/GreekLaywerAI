// 3-1: dependency-free validation of the observability configuration.
//
// YAML is checked as text (the backend deliberately has no YAML parser
// dependency); dashboard JSON is parsed with JSON.parse so malformed
// provisioning fails CI.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

const REQUIRED_ALERTS = [
  'BackendDown',
  'High5xxRate',
  'InferenceQueueBackedUp',
  'RedisDown',
  'DiskSpaceLow',
  'BackupStale'
];

const DASHBOARDS = [
  {
    file: 'monitoring/grafana/dashboards/http.json',
    uid: 'nomos-http',
    metric: 'nomos_http_request_duration_seconds_bucket'
  },
  {
    file: 'monitoring/grafana/dashboards/queue.json',
    uid: 'nomos-queue',
    metric: 'inference_queue_depth'
  },
  {
    file: 'monitoring/grafana/dashboards/database.json',
    uid: 'nomos-db',
    metric: 'nomos_db_query_duration_seconds_bucket'
  },
  {
    file: 'monitoring/grafana/dashboards/overview.json',
    uid: 'nomos-overview',
    metric: 'nomos_backup_last_success_timestamp_seconds'
  }
];

describe('monitoring configuration', () => {
  it('ships every required provisioning file', () => {
    for (const file of [
      'monitoring/prometheus/prometheus.yml',
      'monitoring/prometheus/alerts.yml',
      'monitoring/grafana/provisioning/datasources/prometheus.yml',
      'monitoring/grafana/provisioning/dashboards/dashboards.yml',
      ...DASHBOARDS.map((dashboard) => dashboard.file)
    ]) {
      expect(exists(file)).toBe(true);
    }
  });

  it('scrapes the backend at a short interval and loads the alert rules', () => {
    const config = read('monitoring/prometheus/prometheus.yml');

    expect(config).toMatch(/scrape_interval:\s*15s/);
    expect(config).toMatch(/evaluation_interval:\s*15s/);
    expect(config).toContain('rule_files:');
    expect(config).toContain('/etc/prometheus/alerts.yml');
    expect(config).toMatch(/job_name:\s*backend/);
    expect(config).toContain('backend:3000');
    expect(config).toContain('redis_exporter:9121');
    expect(config).toContain('node_exporter:9100');
  });

  it('defines all required alerts with the expected signals', () => {
    const alerts = read('monitoring/prometheus/alerts.yml');

    for (const alert of REQUIRED_ALERTS) {
      expect(alerts).toMatch(new RegExp(`alert:\\s*${alert}\\b`));
    }

    expect(alerts).toContain('up{job="backend"} == 0');
    expect(alerts).toContain('nomos_http_requests_total{status=~"5.."}');
    expect(alerts).toContain('inference_queue_depth) > 20');
    expect(alerts).toContain('redis_up == 0');
    expect(alerts).toContain('node_filesystem_avail_bytes');
    expect(alerts).toContain('nomos_backup_last_success_timestamp_seconds');
    expect(alerts).toContain('> 48 * 3600');
  });

  it('provisions Grafana with a stable Prometheus datasource and dashboard provider', () => {
    const datasource = read('monitoring/grafana/provisioning/datasources/prometheus.yml');
    const provider = read('monitoring/grafana/provisioning/dashboards/dashboards.yml');

    expect(datasource).toContain('uid: prometheus');
    expect(datasource).toContain('url: http://prometheus:9090');
    expect(datasource).toContain('isDefault: true');

    expect(provider).toContain('/var/lib/grafana/dashboards');
    expect(provider).toMatch(/type:\s*file/);
  });

  it('ships valid dashboard JSON with the required fixed UIDs and metrics', () => {
    const seen = new Set();

    for (const { file, uid, metric } of DASHBOARDS) {
      const dashboard = JSON.parse(read(file));

      expect(dashboard.uid).toBe(uid);
      expect(dashboard.title).toEqual(expect.any(String));
      expect(Array.isArray(dashboard.panels)).toBe(true);
      expect(dashboard.panels.length).toBeGreaterThan(0);
      expect(JSON.stringify(dashboard)).toContain(metric);
      expect(JSON.stringify(dashboard)).toContain('"uid":"prometheus"');
      expect(seen.has(dashboard.uid)).toBe(false);
      seen.add(dashboard.uid);
    }
  });

  it('adds the monitoring services to both compose files without public Prometheus access', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
      const compose = read(file);

      for (const service of ['prometheus', 'grafana', 'redis_exporter', 'node_exporter']) {
        expect(compose).toMatch(new RegExp(`^  ${service}:$`, 'm'));
      }

      expect(compose).toContain('./monitoring/prometheus:/etc/prometheus:ro');
      expect(compose).toContain('./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro');
      expect(compose).toContain('./monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro');
      expect(compose).toContain('127.0.0.1:${GRAFANA_PORT:-3001}:3000');
      expect(compose).toMatch(/^\s+restart:\s+(unless-stopped|always)\s*$/m);
      // Prometheus must never be published to the host.
      expect(compose).not.toMatch(/^\s*-\s*"?9090:9090"?\s*$/m);
      expect(compose).toContain('oliver006/redis_exporter');
      expect(compose).toContain('prom/node-exporter');
    }
  });

  it('preserves existing production services and wires backup freshness', () => {
    const prod = read('docker-compose.prod.yml');
    const dev = read('docker-compose.yml');
    const backup = read('backend/src/scripts/backupDb.js');
    const envExample = read('backend/.env.example');

    expect(prod).toContain('"80:80"');
    expect(prod).toContain('./scraped_laws.json:/usr/src/app/scraped_laws.json:ro');
    expect(prod).toContain('PROM_TEXTFILE_DIR=/prom-textfile');
    expect(prod).toContain('prom_textfile_prod:/prom-textfile');
    expect(dev).toContain('SCRAPED_LAWS_PATH=/usr/src/app/scraped_laws.json');

    expect(backup).toContain('nomos_backup_last_success_timestamp_seconds');
    expect(backup).toContain('PROM_TEXTFILE_DIR');
    expect(envExample).toContain('GRAFANA_ADMIN_PASSWORD');
    expect(envExample).toContain('GRAFANA_PORT');
  });
});
