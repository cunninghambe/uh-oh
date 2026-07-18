import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getIssue, setIssueStatus } from '../db/repos/issues.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';

import { ingest as ingestFn } from './ingest.js';
import { createRateLimiter } from './rate-limit.js';

const env: EventEnvelope = {
  sdk: { name: '@uh-oh/js', version: '0.2.0' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'web',
  release: { version: '2.0.0', build: '9' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'x',
    stacktrace: [{ filename: 'https://h/a.js', function: 'f', lineno: 1, colno: 2, inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'linux', osVersion: '1' },
};

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});
afterEach(() => {
  close();
});

const rl = () => createRateLimiter({ capacity: 10, refillPerSec: 1 });

const regressedCount = async (): Promise<number> => {
  const raw = (await Promise.resolve(metrics.issuesRegressed.get())) as unknown as {
    values: { value: number }[];
  };
  return raw.values.reduce((sum, v) => sum + v.value, 0);
};

describe('regression detection in ingest()', () => {
  it('dispatches issue.regressed immediately, bypassing the dedupe window', async () => {
    const project = createProject(db, { name: 'Reg', webhookUrl: 'https://hooks.test/r' });

    // First event fires issue.new and sets last_alerted_at at t=1000.
    const first = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, env);
    if (first.kind !== 'stored') throw new Error('unreachable');
    setIssueStatus(db, first.issueId, 'resolved');

    const before = await regressedCount();

    // A recurrence 1ms later: well inside the 30-min dedupe window, but the
    // resolved -> regressed transition must dispatch anyway.
    const second = ingestFn({ db, rateLimiter: rl(), now: () => 1_001 }, project.publicKey, env);
    if (second.kind !== 'stored') throw new Error('unreachable');
    expect(second.regressed).toBe(true);
    expect(getIssue(db, second.issueId)?.status).toBe('regressed');

    const due = takeDueDispatches(db, 1_001, 10);
    // Two dispatch rows total: the original issue.new + the issue.regressed one.
    expect(due).toHaveLength(2);
    const regressedDispatch = due.find((d) => d.type === 'issue.regressed');
    expect(regressedDispatch).toBeDefined();
    expect(regressedDispatch?.eventId).toBe(second.eventId);

    // Metric incremented exactly once for the transition.
    expect(await regressedCount()).toBe(before + 1);
  });

  it('subsequent events on a regressed issue respect the normal dedupe window', () => {
    const project = createProject(db, { name: 'Reg2', webhookUrl: 'https://hooks.test/r2' });
    const first = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, env);
    if (first.kind !== 'stored') throw new Error('unreachable');
    setIssueStatus(db, first.issueId, 'resolved');

    // Transition dispatch at t=2000 (bypass).
    ingestFn({ db, rateLimiter: rl(), now: () => 2_000 }, project.publicKey, env);
    // Another event 1ms later — now regressed, inside the dedupe window → no dispatch.
    ingestFn({ db, rateLimiter: rl(), now: () => 2_001 }, project.publicKey, env);

    const due = takeDueDispatches(db, 2_001, 10);
    // issue.new (t=1000) + issue.regressed (t=2000) only — the t=2001 event was deduped.
    expect(due).toHaveLength(2);

    // After the dedupe window elapses, a normal issue.new dispatch fires again.
    const afterWindow = 2_000 + 30 * 60_000 + 1;
    ingestFn({ db, rateLimiter: rl(), now: () => afterWindow }, project.publicKey, env);
    const due2 = takeDueDispatches(db, afterWindow, 10);
    expect(due2).toHaveLength(3);
    expect(due2.filter((d) => d.type === 'issue.regressed')).toHaveLength(1);
  });

  it('does not dispatch a regression when the project has no webhook', () => {
    const project = createProject(db, { name: 'Reg3' });
    const first = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, env);
    if (first.kind !== 'stored') throw new Error('unreachable');
    setIssueStatus(db, first.issueId, 'resolved');
    const second = ingestFn({ db, rateLimiter: rl(), now: () => 1_001 }, project.publicKey, env);
    if (second.kind !== 'stored') throw new Error('unreachable');
    expect(second.regressed).toBe(true);
    expect(takeDueDispatches(db, 1_001, 10)).toHaveLength(0);
  });
});
