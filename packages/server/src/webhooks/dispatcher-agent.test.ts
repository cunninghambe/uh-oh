// §23 webhook payloads: issue.spike (stats as of enqueue time), fix.verified
// (the verified attempt), and the fixAttempt now carried on issue.regressed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { applyFixAttemptTransition, upsertFixAttempt } from '../db/repos/fix-attempts.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { startDispatcher as startDispatcherRaw, type DnsLookupAll } from './dispatcher.js';

const HOUR = 3_600_000;
const NOW = 1_000_000_000;
const WEBHOOK = 'https://hooks.example/agent';
const publicLookup: DnsLookupAll = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
const startDispatcher: typeof startDispatcherRaw = (deps) =>
  startDispatcherRaw({ lookupFn: publicLookup, ...deps });

let db: Db;
let close: () => void;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  projectId = createProject(db, { name: 'App', webhookUrl: WEBHOOK }).id;
});
afterEach(() => close());

const seedIssue = (title = 'TypeError: boom') =>
  upsertIssue(db, { projectId, fingerprint: `fp-${title}`, title, ts: NOW, platform: 'web' }).issue;

const seedEvents = (issueId: string, receivedAt: number, count: number) => {
  let last = '';
  for (let i = 0; i < count; i++) {
    last = insertEvent(db, {
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
    }).id;
  }
  return last;
};

const runOnce = async (now: number): Promise<{ url: string; body: Record<string, unknown> }[]> => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = vi.fn((url: string, init?: { body?: string }) => {
    calls.push({
      url,
      body: (init?.body ? JSON.parse(init.body) : {}) as Record<string, unknown>,
    });
    return Promise.resolve({ ok: true, status: 200 } as Response);
  });
  const handle = startDispatcher({
    db,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => now,
    pollIntervalMs: 10,
    dashboardUrl: 'https://dash.example',
  });
  await new Promise<void>((r) => setTimeout(r, 80));
  await handle.stop();
  return calls;
};

describe('dispatcher — agent-loop payloads', () => {
  it('issue.spike carries stats computed as of the enqueue time', async () => {
    const issue = seedIssue();
    seedEvents(issue.id, NOW - 30 * 60_000, 12); // 12 in the last hour, 0 baseline
    enqueueDispatch(db, { issueId: issue.id, url: WEBHOOK, type: 'issue.spike' }, NOW);

    const calls = await runOnce(NOW + 5000);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body['type']).toBe('issue.spike');
    expect(body['stats']).toEqual({ lastHour: 12, baselineHourly: 0 });
    expect((body['issue'] as Record<string, unknown>)['id']).toBe(issue.id);
    expect(body['url']).toBe(`https://dash.example/issues/${issue.id}`);
    expect(body).not.toHaveProperty('event');
  });

  it('fix.verified carries the verified fix attempt', async () => {
    const issue = seedIssue();
    const { attempt } = upsertFixAttempt(
      db,
      { issueId: issue.id, prUrl: 'https://gh/pr/1' },
      NOW - HOUR,
    );
    applyFixAttemptTransition(db, attempt, 'deployed', NOW - HOUR);
    applyFixAttemptTransition(db, { ...attempt, deployedAt: NOW - HOUR }, 'verified', NOW);
    enqueueDispatch(db, { issueId: issue.id, url: WEBHOOK, type: 'fix.verified' }, NOW);

    const calls = await runOnce(NOW + 5000);
    const body = calls[0]!.body;
    expect(body['type']).toBe('fix.verified');
    const fa = body['fixAttempt'] as Record<string, unknown>;
    expect(fa['prUrl']).toBe('https://gh/pr/1');
    expect(fa['state']).toBe('verified');
  });

  it('issue.regressed carries the fixAttempt that did not hold (null when no deploy)', async () => {
    // With a failed-after-deploy attempt.
    const issue = seedIssue();
    const eventId = seedEvents(issue.id, NOW, 1);
    const { attempt } = upsertFixAttempt(
      db,
      { issueId: issue.id, prUrl: 'https://gh/pr/1' },
      NOW - HOUR,
    );
    applyFixAttemptTransition(db, attempt, 'deployed', NOW - HOUR);
    applyFixAttemptTransition(db, { ...attempt, deployedAt: NOW - HOUR }, 'failed', NOW);
    enqueueDispatch(db, { issueId: issue.id, eventId, url: WEBHOOK, type: 'issue.regressed' }, NOW);

    // And a second issue with no deploy at all.
    const bare = seedIssue('RangeError: nope');
    const bareEvent = seedEvents(bare.id, NOW, 1);
    enqueueDispatch(
      db,
      { issueId: bare.id, eventId: bareEvent, url: WEBHOOK, type: 'issue.regressed' },
      NOW,
    );

    const calls = await runOnce(NOW + 5000);
    const byIssue = new Map(
      calls.map((c) => [(c.body['issue'] as Record<string, unknown>)['id'] as string, c.body]),
    );
    const withFix = byIssue.get(issue.id)!;
    expect((withFix['fixAttempt'] as Record<string, unknown>)['state']).toBe('failed');
    const withoutFix = byIssue.get(bare.id)!;
    expect(withoutFix).toHaveProperty('fixAttempt', null);
  });
});
