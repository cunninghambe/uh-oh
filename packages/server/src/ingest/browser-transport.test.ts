// The browser transport contract for /ingest/*: CORS that a credentialed
// sendBeacon preflight accepts, CORS on every ingest response (errors included),
// text/plain JSON on event ingest, and content-type-agnostic check-ins.
import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getMonitorBySlug } from '../db/repos/monitors.js';
import { listIssues } from '../db/repos/issues.js';
import { usageEvents } from '../db/schema.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});
afterEach(() => close());

const app = (extra: { ipRatePerMinute?: number; ipRateBurst?: number } = {}) =>
  buildServer({ db, secret: TEST_SECRET, password: 'test-password', ...extra });

const SITE = 'https://shop.example.com';

const webEnv: EventEnvelope = {
  sdk: { name: '@uh-oh/js', version: '0.6.0' },
  timestamp: '2026-10-03T12:00:00.000Z',
  platform: 'web',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'x is undefined',
    stacktrace: [{ filename: 'https://shop.example.com/app.js', function: 'boot', inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'Windows', osVersion: '10' },
};

// What Chrome sends before a sendBeacon whose Blob type is application/json.
const preflight = (server: ReturnType<typeof app>, url: string, origin = SITE) =>
  server.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

/**
 * The browser's CORS check for a preflight answering a request whose
 * credentials mode is "include" (every sendBeacon): the wildcard is rejected,
 * the echoed origin must match, and Allow-Credentials must be "true".
 */
const passesCredentialedPreflight = (
  headers: Record<string, string | string[] | number | undefined>,
  origin: string,
): boolean =>
  headers['access-control-allow-origin'] === origin &&
  headers['access-control-allow-credentials'] === 'true' &&
  String(headers['access-control-allow-headers'] ?? '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .includes('content-type') &&
  String(headers['access-control-allow-methods'] ?? '').includes('POST');

describe('ingest CORS: credentialed beacon preflight', () => {
  for (const suffix of ['', '/usage', '/check-in/nightly']) {
    it(`a sendBeacon preflight to /ingest/<key>${suffix} passes the credentialed check`, async () => {
      const res = await preflight(app(), `/ingest/${project.publicKey}${suffix}`);
      expect(res.statusCode).toBe(204);
      expect(passesCredentialedPreflight(res.headers, SITE)).toBe(true);
      expect(res.headers['vary']).toContain('Origin');
      expect(res.headers['access-control-max-age']).toBe('86400');
    });
  }

  it('regression: the old wildcard answer is exactly what Chrome refuses', () => {
    // Pins the failure mode this suite exists for: `*` never satisfies a
    // credentialed request, however the other headers look.
    expect(
      passesCredentialedPreflight(
        {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
        SITE,
      ),
    ).toBe(false);
  });

  it('echoes the origin (with credentials) on the POST itself', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { origin: SITE },
      payload: webEnv,
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('keeps the wildcard (no credentials) when there is no Origin header', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: webEnv,
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('echoes every real web origin shape the production log shows (and IPv6, extensions)', async () => {
    const server = app();
    for (const origin of [
      'http://localhost:3100',
      'http://203.0.113.10:3456',
      'https://app.example.com',
      'http://[::1]:4320',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    ]) {
      const res = await preflight(server, `/ingest/${project.publicKey}/usage`, origin);
      expect(passesCredentialedPreflight(res.headers, origin), origin).toBe(true);
    }
  });

  it('answers an opaque or malformed Origin with the wildcard, never echoing it', async () => {
    for (const origin of [
      'null',
      'not a url',
      'https://evil.example/path',
      'https://user@shop.example.com',
      'https://a.example,https://b.example',
      'https://a.example:notaport',
      'https://a.example:123456',
    ]) {
      const res = await preflight(app(), `/ingest/${project.publicKey}/usage`, origin);
      expect(res.statusCode, origin).toBe(204);
      expect(res.headers['access-control-allow-origin'], origin).toBe('*');
      expect(res.headers['access-control-allow-credentials'], origin).toBeUndefined();
    }
  });

  it('leaves /api same-origin: no CORS headers even when an Origin is sent', async () => {
    const server = app();
    const get = await server.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { origin: SITE },
    });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
    expect(get.headers['access-control-allow-credentials']).toBeUndefined();
    const opt = await preflight(server, '/api/projects');
    expect(opt.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('ingest CORS on error responses', () => {
  it('the per-IP limiter 429 on /ingest carries CORS headers', async () => {
    const server = app({ ipRatePerMinute: 1, ipRateBurst: 1 });
    const ok = await server.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { origin: SITE },
      payload: webEnv,
    });
    expect(ok.statusCode).toBe(202);
    const limited = await server.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { origin: SITE },
      payload: webEnv,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('a malformed JSON body (400) carries CORS headers', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { origin: SITE, 'content-type': 'application/json' },
      payload: '{"not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('an over-cap body (413) carries CORS headers', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}/usage`,
      headers: { origin: SITE, 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [], pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('an unknown key (401) carries CORS headers on every ingest route', async () => {
    const server = app();
    for (const [url, payload] of [
      ['/ingest/pk_nope', webEnv],
      ['/ingest/pk_nope/usage', { events: [] }],
      ['/ingest/pk_nope/check-in/nightly?intervalMinutes=5', undefined],
    ] as const) {
      const res = await server.inject({
        method: 'POST',
        url,
        headers: { origin: SITE },
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['access-control-allow-origin'], url).toBe(SITE);
    }
  });
});

describe('event ingest accepts a text/plain JSON body (preflight-free beacon)', () => {
  it('stores a crash envelope sent as text/plain', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { origin: SITE, 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify(webEnv),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json<{ eventId: string }>().eventId).toEqual(expect.any(String));
    expect(listIssues(db, { projectId: project.id }).total).toBe(1);
  });

  it('turns unparseable text/plain into a clean 400 invalid_envelope', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'definitely not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_envelope');
    expect(listIssues(db, { projectId: project.id }).total).toBe(0);
  });

  it('holds text/plain to the same prototype-poisoning rule as application/json', async () => {
    const server = app();
    const poisoned = [
      ['/ingest/KEY', JSON.stringify(webEnv).replace(/^\{/, '{"__proto__":{"polluted":true},')],
      [
        '/ingest/KEY',
        JSON.stringify(webEnv).replace(/^\{/, '{"constructor":{"prototype":{"x":1}},'),
      ],
      [
        '/ingest/KEY/usage',
        '{"events":[{"type":"event","name":"n","props":{"__proto__":{"polluted":true}}}]}',
      ],
    ] as const;
    for (const [route, body] of poisoned) {
      const url = route.replace('KEY', project.publicKey);
      const asJson = await server.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(asJson.statusCode, `${url} application/json`).toBe(400);
      const asText = await server.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        payload: body,
      });
      expect(asText.statusCode, `${url} text/plain`).toBe(400);
    }
    expect(listIssues(db, { projectId: project.id }).total).toBe(0);
    expect(db.select().from(usageEvents).all()).toHaveLength(0);
  });

  it('turns empty or whitespace-only text/plain into a clean 400 on both routes', async () => {
    const server = app();
    for (const payload of ['', '   ']) {
      const crash = await server.inject({
        method: 'POST',
        url: `/ingest/${project.publicKey}`,
        headers: { 'content-type': 'text/plain' },
        payload,
      });
      expect(crash.statusCode).toBe(400);
      expect(crash.json<{ error: string }>().error).toBe('invalid_envelope');
      const usage = await server.inject({
        method: 'POST',
        url: `/ingest/${project.publicKey}/usage`,
        headers: { 'content-type': 'text/plain' },
        payload,
      });
      expect(usage.statusCode).toBe(400);
      expect(usage.json<{ error: string }>().error).toBe('invalid_body');
    }
  });

  it('usage still accepts text/plain after the parser moved to the shared module', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}/usage`,
      headers: { origin: SITE, 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify({ events: [{ type: 'pageview', path: '/beacon' }] }),
    });
    expect(res.statusCode).toBe(202);
    expect(db.select().from(usageEvents).all()).toHaveLength(1);
  });
});

describe('check-in accepts any content type (the body is ignored)', () => {
  const cases: Array<{ name: string; headers: Record<string, string>; payload?: string }> = [
    {
      name: 'form-encoded, empty (Apps Script UrlFetchApp default, curl -d "")',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    },
    {
      name: 'form-encoded with a body (curl -d a=b)',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    },
    {
      name: 'application/json with an empty body',
      headers: { 'content-type': 'application/json' },
      payload: '',
    },
    {
      name: 'application/json with a body',
      headers: { 'content-type': 'application/json' },
      payload: '{"status":"ok"}',
    },
    {
      name: 'text/plain empty (what the js client sends)',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: '',
    },
    { name: 'no content type, no body (plain curl -X POST)', headers: {} },
  ];

  for (const [i, c] of cases.entries()) {
    it(`202 and creates the monitor: ${c.name}`, async () => {
      const slug = `job-${String(i)}`;
      const res = await app().inject({
        method: 'POST',
        url: `/ingest/${project.publicKey}/check-in/${slug}?intervalMinutes=60`,
        headers: c.headers,
        ...(c.payload !== undefined ? { payload: c.payload } : {}),
      });
      expect(res.statusCode).toBe(202);
      expect(getMonitorBySlug(db, project.id, slug)).not.toBeNull();
    });
  }

  it('still enforces the global body cap on a check-in', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}/check-in/big?intervalMinutes=60`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1_100_000),
    });
    expect(res.statusCode).toBe(413);
    expect(getMonitorBySlug(db, project.id, 'big')).toBeNull();
  });
});

describe('per-IP limiter skip list ignores the query string', () => {
  it('/healthz with a cache-busting query is never rate limited', async () => {
    const server = app({ ipRatePerMinute: 1, ipRateBurst: 1 });
    for (let i = 0; i < 5; i++) {
      const res = await server.inject({ method: 'GET', url: `/healthz?probe=${String(i)}` });
      expect(res.statusCode).toBe(200);
    }
  });
});
