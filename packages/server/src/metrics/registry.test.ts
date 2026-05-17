import { describe, expect, it, beforeEach } from 'vitest';
import { Registry, Counter, Histogram } from 'prom-client';

describe('metrics registry', () => {
  // Use isolated registries so tests don't share state
  let reg: Registry;
  let eventsIngested: Counter<'outcome'>;
  let issuesNew: Counter;
  let webhookFailures: Counter;
  let requestDuration: Histogram<'route' | 'status_code'>;

  beforeEach(() => {
    reg = new Registry();
    eventsIngested = new Counter({
      name: 'uh_oh_events_ingested_total',
      help: 'Total events accepted',
      labelNames: ['outcome'] as const,
      registers: [reg],
    });
    issuesNew = new Counter({
      name: 'uh_oh_issues_new_total',
      help: 'Total new issues',
      registers: [reg],
    });
    webhookFailures = new Counter({
      name: 'uh_oh_webhook_failures_total',
      help: 'Total webhook failures',
      registers: [reg],
    });
    requestDuration = new Histogram({
      name: 'uh_oh_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['route', 'status_code'] as const,
      buckets: [0.1, 0.5, 1],
      registers: [reg],
    });
  });

  it('eventsIngested increments by outcome label', async () => {
    eventsIngested.inc({ outcome: 'stored' });
    eventsIngested.inc({ outcome: 'stored' });
    eventsIngested.inc({ outcome: 'rate-limited' });

    const text = await reg.metrics();
    expect(text).toContain('uh_oh_events_ingested_total{outcome="stored"} 2');
    expect(text).toContain('uh_oh_events_ingested_total{outcome="rate-limited"} 1');
  });

  it('issuesNew increments correctly', async () => {
    issuesNew.inc();
    issuesNew.inc();

    const text = await reg.metrics();
    expect(text).toContain('uh_oh_issues_new_total 2');
  });

  it('webhookFailures increments correctly', async () => {
    webhookFailures.inc();

    const text = await reg.metrics();
    expect(text).toContain('uh_oh_webhook_failures_total 1');
  });

  it('requestDuration records observations', async () => {
    requestDuration.observe({ route: '/healthz', status_code: '200' }, 0.05);
    requestDuration.observe({ route: '/ingest/:publicKey', status_code: '202' }, 0.2);

    const text = await reg.metrics();
    expect(text).toContain('uh_oh_request_duration_seconds');
    expect(text).toContain('route="/healthz"');
  });

  it('registry output is Prometheus text format', async () => {
    eventsIngested.inc({ outcome: 'stored' });
    const text = await reg.metrics();
    // Prometheus text format begins with # HELP
    expect(text).toMatch(/^# HELP uh_oh_events_ingested_total/m);
    expect(text).toMatch(/^# TYPE uh_oh_events_ingested_total counter/m);
  });
});
