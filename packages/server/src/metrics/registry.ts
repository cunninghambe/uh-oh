import { Counter, Histogram, Registry } from 'prom-client';

export const registry = new Registry();

export const metrics = {
  eventsIngested: new Counter({
    name: 'uh_oh_events_ingested_total',
    help: 'Total events accepted (stored or rate-limited)',
    labelNames: ['outcome'] as const,
    registers: [registry],
  }),

  issuesNew: new Counter({
    name: 'uh_oh_issues_new_total',
    help: 'Total NEW issues created',
    registers: [registry],
  }),

  webhookFailures: new Counter({
    name: 'uh_oh_webhook_failures_total',
    help: 'Total webhook attempts that failed permanently',
    registers: [registry],
  }),

  requestDuration: new Histogram({
    name: 'uh_oh_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  }),
};
