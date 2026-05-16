import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { getIssue, listIssues } from '../db/repos/issues.js';
import { createProject } from '../db/repos/projects.js';
import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getEvent, listEventsForIssue } from '../db/repos/events.js';
import { makeTestDb } from '../db/test-utils.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';

import { ingest as ingestFn } from './ingest.js';
import { createRateLimiter } from './rate-limit.js';

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
    expect(listEventsForIssue(db, first.issueId)).toHaveLength(2);
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
    expect(listEventsForIssue(db, issueId)).toHaveLength(3);
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
    const app = buildServer({ db });
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
    const app = buildServer({ db });
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/nope',
      payload: validEnv,
    });
    expect(res.statusCode).toBe(401);
  });

  it('400 with field path on missing required field', async () => {
    const app = buildServer({ db });
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
    const app = buildServer({ db });
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${project.publicKey}`,
      payload: { ...validEnv, platform: 'windows' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('preserves unknown top-level fields via .loose() schema', async () => {
    const app = buildServer({ db });
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
    const app = buildServer({ db, ingest });
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
    const app = buildServer({ db });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
