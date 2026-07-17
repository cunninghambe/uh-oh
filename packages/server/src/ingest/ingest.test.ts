import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { getIssue, listIssues } from '../db/repos/issues.js';
import { createProject } from '../db/repos/projects.js';
import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getEvent, listEventsForIssue } from '../db/repos/events.js';
import { listReleasesForProject } from '../db/repos/releases.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { makeTestDb } from '../db/test-utils.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';
import { metrics } from '../metrics/registry.js';

import { ingest as ingestFn } from './ingest.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';

const TEST_PASSWORD = 'test-password';

let db: Db;
let close: () => void;
let project: ProjectRow;

const validEnv: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'x',
    stacktrace: [{ module: 'src/App.tsx', function: 'render', inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [
    {
      ts: '2026-05-16T11:59:50.000Z',
      category: 'nav',
      level: 'info',
      message: 'home',
    },
  ],
  device: { osName: 'Android', osVersion: '14' },
};

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});

afterEach(() => {
  close();
});

describe('ingest()', () => {
  it('stores event + breadcrumbs and creates new issue on first call', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    const r = ingestFn({ db, rateLimiter: rl }, project.publicKey, validEnv);
    expect(r.kind).toBe('stored');
    if (r.kind !== 'stored') throw new Error('unreachable');
    expect(r.isNewIssue).toBe(true);
    const ev = getEvent(db, r.eventId);
    expect(ev?.fingerprint).toBe('TypeError::src/App.tsx:render');
    const bcs = listBreadcrumbs(db, r.eventId);
    expect(bcs).toHaveLength(1);
    expect(bcs[0]?.message).toBe('home');
  });

  it('returns unknown-key for bad publicKey', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    expect(ingestFn({ db, rateLimiter: rl }, 'nope', validEnv).kind).toBe('unknown-key');
  });

  it('repeat same fingerprint increments event_count and stores second event', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    const first = ingestFn({ db, rateLimiter: rl }, project.publicKey, validEnv);
    const second = ingestFn({ db, rateLimiter: rl }, project.publicKey, validEnv);
    expect(second.kind).toBe('stored');
    if (first.kind !== 'stored' || second.kind !== 'stored') throw new Error('unreachable');
    expect(first.issueId).toBe(second.issueId);
    const issue = getIssue(db, first.issueId);
    expect(issue?.eventCount).toBe(2);
    expect(listEventsForIssue(db, first.issueId).rows).toHaveLength(2);
  });

  it('rate-limited extra events bump count but skip event row', () => {
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 0 });
    const deps = { db, rateLimiter: rl, now: () => 1_000 };
    let stored = 0;
    let limited = 0;
    let issueId = '';
    for (let i = 0; i < 100; i++) {
      const r = ingestFn(deps, project.publicKey, validEnv);
      if (r.kind === 'stored') {
        stored++;
        issueId = r.issueId;
      } else if (r.kind === 'rate-limited') {
        limited++;
        issueId = r.issueId;
      }
    }
    expect(stored).toBe(3);
    expect(limited).toBe(97);
    const issue = getIssue(db, issueId);
    expect(issue?.eventCount).toBe(100);
    expect(listEventsForIssue(db, issueId).rows).toHaveLength(3);
  });

  it('SDK fingerprint override creates separate issue', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    const a = ingestFn({ db, rateLimiter: rl }, project.publicKey, validEnv);
    const b = ingestFn({ db, rateLimiter: rl }, project.publicKey, {
      ...validEnv,
      fingerprint: ['custom-group'],
    });
    if (a.kind !== 'stored' || b.kind !== 'stored') throw new Error('unreachable');
    expect(a.issueId).not.toBe(b.issueId);
  });
});

describe('POST /ingest/:publicKey', () => {
  it('202 + persists on valid envelope', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: validEnv,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ eventId: string }>();
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(listIssues(db, { projectId: project.id }).total).toBe(1);
  });

  it('401 on unknown publicKey', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/nope',
      payload: validEnv,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 with field path on missing required field', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const { exception: _drop, ...rest } = validEnv;
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ issues: Array<{ path: (string | number)[] }> }>();
    expect(body.issues.some((i) => i.path[0] === 'exception')).toBe(true);
  });

  it('400 on invalid platform enum', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: { ...validEnv, platform: 'windows' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('preserves unknown top-level fields via .loose() schema', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: { ...validEnv, futureField: { keep: 'me' } },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ eventId: string }>();
    const ev = getEvent(db, body.eventId);
    const payload = JSON.parse(ev?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['futureField']).toEqual({ keep: 'me' });
  });

  it('returns rateLimited:true when bucket empty', async () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 0 });
    const ingest = (publicKey: string, env: EventEnvelope) =>
      ingestFn({ db, rateLimiter: rl, now: () => 1_000 }, publicKey, env);
    const app = buildServer({ db, ingest, secret: TEST_SECRET, password: TEST_PASSWORD });
    const first = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: validEnv,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: validEnv,
    });
    expect(first.statusCode).toBe(202);
    expect(first.json<{ eventId: string | null }>().eventId).not.toBeNull();
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual({ eventId: null, rateLimited: true });
  });

  it('healthz returns ok', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('webhook dispatch hook in ingest()', () => {
  const rl = () => createRateLimiter({ capacity: 10, refillPerSec: 1 });

  it('enqueues a dispatch row when project has webhookUrl set', () => {
    const p = createProject(db, { name: 'Hooked', webhookUrl: 'https://hooks.test/x' });
    const r = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, p.publicKey, validEnv);
    expect(r.kind).toBe('stored');
    const due = takeDueDispatches(db, 1_000, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.url).toBe('https://hooks.test/x');
  });

  it('does NOT enqueue when project has no webhookUrl', () => {
    // project has no webhookUrl (created in beforeEach without one)
    const r = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, validEnv);
    expect(r.kind).toBe('stored');
    const due = takeDueDispatches(db, 1_000, 10);
    expect(due).toHaveLength(0);
  });

  it('does NOT enqueue a second dispatch for same fingerprint within dedupe window', () => {
    const p = createProject(db, { name: 'Hooked2', webhookUrl: 'https://hooks.test/y' });
    const deps = { db, rateLimiter: rl(), now: () => 1_000 };
    ingestFn(deps, p.publicKey, validEnv); // first — fires
    ingestFn(deps, p.publicKey, validEnv); // second — within 30min window
    const due = takeDueDispatches(db, 1_000, 10);
    expect(due).toHaveLength(1); // only one dispatch row
  });

  it('enqueues a new dispatch after the dedupe window expires', () => {
    const dedupeMinutes = 30;
    const p = createProject(db, { name: 'Hooked3', webhookUrl: 'https://hooks.test/z' });
    // alertDedupeMinutes defaults to 30
    ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, p.publicKey, validEnv);

    const afterWindow = 1_000 + dedupeMinutes * 60_000 + 1;
    ingestFn({ db, rateLimiter: rl(), now: () => afterWindow }, p.publicKey, validEnv);

    const due = takeDueDispatches(db, afterWindow, 10);
    expect(due).toHaveLength(2);
  });
});

describe('ingest() — metrics only after commit (L4)', () => {
  type MetricValue = { value: number; labels: Record<string, string | number> };
  const storedCount = async (): Promise<number> => {
    const raw = (await Promise.resolve(metrics.eventsIngested.get())) as unknown as {
      values: MetricValue[];
    };
    return raw.values
      .filter((v) => v.labels['outcome'] === 'stored')
      .reduce((sum, v) => sum + v.value, 0);
  };

  it('does not increment metrics or persist rows when the transaction throws', async () => {
    const throwing: RateLimiter = {
      consume: () => {
        throw new Error('boom');
      },
      cleanup: () => undefined,
      size: () => 0,
    };
    const before = await storedCount();
    expect(() => ingestFn({ db, rateLimiter: throwing }, project.publicKey, validEnv)).toThrow(
      'boom',
    );
    // Metrics unchanged and nothing persisted (whole tx rolled back).
    expect(await storedCount()).toBe(before);
    expect(listIssues(db, { projectId: project.id }).total).toBe(0);
  });

  it('increments the stored counter on a successful ingest', async () => {
    const before = await storedCount();
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    ingestFn({ db, rateLimiter: rl }, project.publicKey, validEnv);
    expect(await storedCount()).toBe(before + 1);
  });
});

describe('web + node runtimes (v0.2 @uh-oh/js)', () => {
  const webEnv: EventEnvelope = {
    sdk: { name: '@uh-oh/js', version: '0.2.0' },
    timestamp: '2026-05-16T12:00:00.000Z',
    platform: 'web',
    release: { version: '2.0.0', build: '9' },
    level: 'error',
    exception: {
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'x')",
      stacktrace: [
        {
          filename: 'https://app.example.com/assets/main-abc123.js',
          function: 'handleClick',
          lineno: 42,
          colno: 13,
          inApp: true,
        },
      ],
      mechanism: 'js-global',
    },
    breadcrumbs: [],
    device: { osName: 'Windows', osVersion: '10.0' },
  };

  const nodeEnv: EventEnvelope = {
    sdk: { name: '@uh-oh/js', version: '0.2.0' },
    timestamp: '2026-05-16T12:00:00.000Z',
    platform: 'node',
    release: { version: '2.0.0', build: '9' },
    level: 'error',
    exception: {
      type: 'Error',
      value: 'ECONNREFUSED',
      stacktrace: [
        {
          filename: '/srv/app/dist/worker.js',
          function: 'connect',
          lineno: 88,
          colno: 7,
          inApp: true,
        },
      ],
      mechanism: 'js-global',
    },
    breadcrumbs: [],
    device: { osName: 'linux', osVersion: 'v20.11.1', arch: 'x64' },
  };

  it('accepts a web envelope: 202 + event/issue/release rows carry platform web', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: webEnv,
    });
    expect(res.statusCode).toBe(202);
    const { eventId } = res.json<{ eventId: string }>();
    expect(getEvent(db, eventId)?.platform).toBe('web');
    expect(listIssues(db, { projectId: project.id }).total).toBe(1);
    const releases = listReleasesForProject(db, project.id);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.platform).toBe('web');
  });

  it('accepts a node envelope: 202 + event/issue/release rows carry platform node', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: nodeEnv,
    });
    expect(res.statusCode).toBe(202);
    const { eventId } = res.json<{ eventId: string }>();
    expect(getEvent(db, eventId)?.platform).toBe('node');
    const releases = listReleasesForProject(db, project.id);
    expect(releases).toHaveLength(1);
    expect(releases[0]?.platform).toBe('node');
  });

  it('fingerprints web/node stacks deterministically (same stack groups; different stack splits)', () => {
    const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    const a = ingestFn({ db, rateLimiter: rl }, project.publicKey, webEnv);
    const b = ingestFn({ db, rateLimiter: rl }, project.publicKey, webEnv);
    const c = ingestFn({ db, rateLimiter: rl }, project.publicKey, nodeEnv);
    if (a.kind !== 'stored' || b.kind !== 'stored' || c.kind !== 'stored') {
      throw new Error('unreachable');
    }
    // Identical web stacks group into one issue; the node stack is its own.
    expect(a.issueId).toBe(b.issueId);
    expect(a.issueId).not.toBe(c.issueId);
    expect(getIssue(db, a.issueId)?.eventCount).toBe(2);
  });
});

describe('CORS on ingest (L1)', () => {
  it('OPTIONS preflight returns 204 with Access-Control-Allow-Origin: *', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({ method: 'OPTIONS', url: `/ingest/${project.publicKey}` });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('POST /ingest carries Access-Control-Allow-Origin: *', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: validEnv,
    });
    expect(res.statusCode).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('/api responses do not carry CORS headers', async () => {
    const app = buildServer({ db, secret: TEST_SECRET, password: TEST_PASSWORD });
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
