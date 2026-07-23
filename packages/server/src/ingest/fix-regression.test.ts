// CONTRACT A (§23) — the regression hook. A post-deploy event that regresses an
// issue (§18 resolved->regressed) also fails the most-recently-deployed fix
// attempt, writes a system annotation, and increments uh_oh_fix_failed_total.

import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { setIssueStatus } from '../db/repos/issues.js';
import {
  applyFixAttemptTransition,
  getFixAttempt,
  upsertFixAttempt,
} from '../db/repos/fix-attempts.js';
import { listAnnotations } from '../db/repos/annotations.js';
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
afterEach(() => close());

const rl = () => createRateLimiter({ capacity: 10, refillPerSec: 1 });

const failedCount = async (): Promise<number> => {
  const m = await metrics.fixFailed.get();
  return m.values.reduce((s, v) => s + v.value, 0);
};

describe('regression fails the most-recently-deployed fix attempt', () => {
  it('flips the deployed attempt to failed, annotates, and counts the failure', async () => {
    const project = createProject(db, { name: 'Reg', webhookUrl: 'https://hooks.test/r' });
    const first = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, env);
    if (first.kind !== 'stored') throw new Error('unreachable');

    // A fix is filed + deployed, and the issue is resolved (as the deploy would do).
    const { attempt } = upsertFixAttempt(
      db,
      { issueId: first.issueId, prUrl: 'https://gh/pr/1' },
      2_000,
    );
    applyFixAttemptTransition(db, attempt, 'deployed', 2_000);
    setIssueStatus(db, first.issueId, 'resolved');
    const before = await failedCount();

    // A recurrence regresses the issue AND fails the fix.
    const second = ingestFn({ db, rateLimiter: rl(), now: () => 3_000 }, project.publicKey, env);
    if (second.kind !== 'stored') throw new Error('unreachable');
    expect(second.regressed).toBe(true);

    expect(getFixAttempt(db, attempt.id)?.state).toBe('failed');
    expect(await failedCount()).toBe(before + 1);

    // System audit annotation on the transition.
    const { rows } = listAnnotations(db, first.issueId, {});
    expect(rows.some((r) => r.kind === 'system' && r.body.includes('regressed'))).toBe(true);

    // The issue.regressed dispatch was still enqueued.
    const due = takeDueDispatches(db, 3_000, 10);
    expect(due.some((d) => d.type === 'issue.regressed')).toBe(true);
  });

  it('does not fail anything when the regression was not preceded by a deploy', async () => {
    const project = createProject(db, { name: 'Reg2', webhookUrl: 'https://hooks.test/r2' });
    const first = ingestFn({ db, rateLimiter: rl(), now: () => 1_000 }, project.publicKey, env);
    if (first.kind !== 'stored') throw new Error('unreachable');
    setIssueStatus(db, first.issueId, 'resolved');
    const before = await failedCount();

    const second = ingestFn({ db, rateLimiter: rl(), now: () => 2_000 }, project.publicKey, env);
    if (second.kind !== 'stored') throw new Error('unreachable');
    expect(second.regressed).toBe(true);
    expect(await failedCount()).toBe(before);
  });
});
