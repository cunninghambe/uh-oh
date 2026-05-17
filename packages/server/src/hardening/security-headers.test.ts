import { describe, expect, it } from 'vitest';

import { makeTestDb } from '../db/test-utils.js';
import { buildServer } from '../server.js';

describe('security headers', () => {
  const { db } = makeTestDb();

  it('sets all required security headers on /healthz', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['permissions-policy']).toBe('geolocation=(), microphone=(), camera=()');
  });

  it('sets security headers on 404 responses', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/nonexistent-route-xyz' });

    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets security headers on /metrics', async () => {
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/metrics' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets security headers on ingest endpoint (4xx)', async () => {
    const app = buildServer({ db });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/unknown-key',
      payload: { invalid: true },
    });

    // 400 from validation — still gets headers
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
