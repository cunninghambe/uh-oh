// CONTRACT V (§23) — the fix-verification sweep + its env validation. A deployed
// attempt whose deploy is old enough and whose issue stayed silent flips to
// 'verified' and dispatches fix.verified; a post-deploy event blocks it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject, updateProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import {
  applyFixAttemptTransition,
  getFixAttempt,
  upsertFixAttempt,
} from '../db/repos/fix-attempts.js';
import { listAnnotations } from '../db/repos/annotations.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';
import {
  DEFAULT_FIX_VERIFY_DAYS,
  resolveFixVerifyDays,
  startFixVerifySweep,
  sweepFixVerification,
} from './verify-sweep.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const WEBHOOK = 'https://hooks.example/fixes';

describe('resolveFixVerifyDays', () => {
  it('defaults when unset or empty', () => {
    expect(resolveFixVerifyDays(undefined)).toBe(DEFAULT_FIX_VERIFY_DAYS);
    expect(resolveFixVerifyDays('')).toBe(DEFAULT_FIX_VERIFY_DAYS);
  });
  it('accepts a valid integer >= 1', () => {
    expect(resolveFixVerifyDays('1')).toBe(1);
    expect(resolveFixVerifyDays('14')).toBe(14);
  });
  it('throws (fails boot) on an invalid value', () => {
    expect(() => resolveFixVerifyDays('0')).toThrow(/>= 1/);
    expect(() => resolveFixVerifyDays('-3')).toThrow();
    expect(() => resolveFixVerifyDays('nope')).toThrow();
    expect(() => resolveFixVerifyDays('2.5')).toThrow();
  });
});

describe('sweepFixVerification', () => {
  let db: Db;
  let close: () => void;
  let projectId: string;
  let issueId: string;

  beforeEach(() => {
    ({ db, close } = makeTestDb());
    const p = createProject(db, { name: 'App', webhookUrl: WEBHOOK });
    projectId = p.id;
    const { issue } = upsertIssue(db, {
      projectId,
      fingerprint: 'fp',
      title: 'TypeError: boom',
      ts: NOW,
      platform: 'web',
    });
    issueId = issue.id;
  });
  afterEach(() => close());

  const deployAttempt = (prUrl: string, deployedAt: number): string => {
    const { attempt } = upsertFixAttempt(db, { issueId, prUrl }, deployedAt);
    applyFixAttemptTransition(db, attempt, 'deployed', deployedAt);
    return attempt.id;
  };

  const seedEvent = (receivedAt: number) =>
    insertEvent(db, {
      projectId,
      issueId,
      releaseId: null,
      fingerprint: 'fp',
      level: 'error',
      platform: 'web',
      payload: '{}',
      receivedAt,
      deviceInfo: '{}',
      userInfo: null,
    });

  const verifiedCount = async (): Promise<number> => {
    const m = await metrics.fixVerified.get();
    return m.values.reduce((s, v) => s + v.value, 0);
  };

  it('verifies a deployed attempt after a quiet window and dispatches fix.verified', async () => {
    const id = deployAttempt('https://gh/pr/1', NOW);
    const before = await verifiedCount();

    expect(sweepFixVerification(db, NOW + 7 * DAY, 7)).toBe(1);
    expect(getFixAttempt(db, id)?.state).toBe('verified');
    expect(await verifiedCount()).toBe(before + 1);

    const dispatched = takeDueDispatches(db, NOW + 7 * DAY + 1, 100).filter(
      (d) => d.type === 'fix.verified',
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.issueId).toBe(issueId);

    // A kind:'system' audit annotation records the transition.
    const { rows } = listAnnotations(db, issueId, {});
    expect(rows.some((a) => a.kind === 'system' && a.body.includes('verified'))).toBe(true);
  });

  it('leaves an attempt whose deploy is not old enough', () => {
    const id = deployAttempt('https://gh/pr/1', NOW);
    expect(sweepFixVerification(db, NOW + 6 * DAY, 7)).toBe(0);
    expect(getFixAttempt(db, id)?.state).toBe('deployed');
  });

  it('does not verify when the issue had an event since the deploy', () => {
    const id = deployAttempt('https://gh/pr/1', NOW);
    seedEvent(NOW + 60_000); // a post-deploy event
    expect(sweepFixVerification(db, NOW + 7 * DAY, 7)).toBe(0);
    expect(getFixAttempt(db, id)?.state).toBe('deployed');
  });

  const verifiedDispatches = (now: number) =>
    takeDueDispatches(db, now, 100).filter((d) => d.type === 'fix.verified');

  it('dispatches to the instance default when the project has no webhook of its own', () => {
    updateProject(db, projectId, { webhookUrl: null });
    deployAttempt('https://gh/pr/1', NOW);

    expect(
      sweepFixVerification(db, NOW + 7 * DAY, 7, {
        defaultWebhookUrl: 'https://hooks.example/instance',
      }),
    ).toBe(1);

    const dispatched = verifiedDispatches(NOW + 7 * DAY + 1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.url).toBe('https://hooks.example/instance');
  });

  it('warns when a verification has nowhere to go', () => {
    updateProject(db, projectId, { webhookUrl: null });
    deployAttempt('https://gh/pr/1', NOW);
    const warn = vi.fn();

    expect(sweepFixVerification(db, NOW + 7 * DAY, 7, { logger: { error: vi.fn(), warn } })).toBe(
      1,
    );
    expect(verifiedDispatches(NOW + 7 * DAY + 1)).toEqual([]);

    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('fix.verified');
    expect(msg).toContain('App');
    expect(msg).toContain('UH_OH_DEFAULT_WEBHOOK_URL');
  });

  it('startFixVerifySweep runs via sweepOnce and stops cleanly', () => {
    const id = deployAttempt('https://gh/pr/1', NOW);
    const handle = startFixVerifySweep({ db, verifyDays: 7, intervalMs: 1_000_000 });
    try {
      expect(handle.sweepOnce(NOW + 7 * DAY)).toBe(1);
      expect(getFixAttempt(db, id)?.state).toBe('verified');
    } finally {
      handle.stop();
    }
  });
});
