import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../db/test-utils.js';
import { buildServer } from '../server.js';

describe('GET /metrics', () => {
  const { db } = makeTestDb();

  it('returns 200 with text/plain content-type', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('body includes uh_oh_events_ingested_total metric family', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.body).toContain('uh_oh_events_ingested_total');
  });

  it('body includes all four required metric families', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.body).toContain('uh_oh_events_ingested_total');
    expect(res.body).toContain('uh_oh_issues_new_total');
    expect(res.body).toContain('uh_oh_webhook_failures_total');
    expect(res.body).toContain('uh_oh_request_duration_seconds');
  });

  it('body is Prometheus text format (has # HELP lines)', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.body).toMatch(/^# HELP uh_oh_events_ingested_total/m);
    expect(res.body).toMatch(/^# TYPE uh_oh_events_ingested_total counter/m);
  });

  it('does not require auth', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    // No Authorization header — must still succeed
    expect(res.statusCode).toBe(200);
  });
});
