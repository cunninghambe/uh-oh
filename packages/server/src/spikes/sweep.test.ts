// CONTRACT S (§23) — the spike sweep. Fires issue.spike exactly once per episode
// against a quiet baseline, never for steady-state noise, and clears silently.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getIssue, setIssueStatus, upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';
import { sweepSpikes, startSpikeSweep } from './sweep.js';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const WEBHOOK = 'https://hooks.example/spikes';

let db: Db;
let close: () => void;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const p = createProject(db, { name: 'App', webhookUrl: WEBHOOK });
  projectId = p.id;
});
afterEach(() => close());

let fpN = 0;
const seedIssue = (lastSeen = NOW) => {
  const { issue } = upsertIssue(db, {
    projectId,
    fingerprint: `fp-${fpN++}`,
    title: 'TypeError: boom',
    ts: lastSeen,
    platform: 'web',
  });
  return issue;
};

const seedEvents = (issueId: string, receivedAt: number, count: number) => {
  for (let i = 0; i < count; i++) {
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
  }
};

const spikeDispatches = (now: number) =>
  takeDueDispatches(db, now, 100).filter((d) => d.type === 'issue.spike');

const counter = async (): Promise<number> => {
  const m = await metrics.issueSpikes.get();
  return m.values.reduce((s, v) => s + v.value, 0);
};

describe('sweepSpikes', () => {
  it('fires issue.spike exactly once per episode, then clears silently', async () => {
    const issue = seedIssue(NOW);
    // 12 events in the last hour, zero baseline → spiking (threshold max(10,0)=10).
    seedEvents(issue.id, NOW - 30 * 60_000, 12);
    const before = await counter();

    expect(sweepSpikes(db, NOW)).toBe(1);
    expect(getIssue(db, issue.id)?.spikeActive).toBe(true);
    expect(getIssue(db, issue.id)?.lastSpikeAt).toBe(NOW);
    expect(await counter()).toBe(before + 1);

    const fired = spikeDispatches(NOW + 1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.issueId).toBe(issue.id);
    expect(fired[0]?.eventId).toBeNull();

    // The transition is the dedupe: a second sweep while still spiking does nothing.
    expect(sweepSpikes(db, NOW + 60_000)).toBe(0);
    expect(spikeDispatches(NOW + 2 * 60_000)).toHaveLength(1);

    // Two hours later the burst has aged out of the last-hour window → the
    // condition clears silently (spike_active reset, no new dispatch).
    const later = NOW + 2 * HOUR;
    expect(sweepSpikes(db, later)).toBe(0);
    expect(getIssue(db, issue.id)?.spikeActive).toBe(false);
    expect(spikeDispatches(later + 1)).toHaveLength(1);
  });

  it('never fires for a steady-state noisy issue (baseline ≈ lastHour)', () => {
    const issue = seedIssue(NOW);
    // Baseline of 240 events across the prior 24h → baselineHourly 10 → threshold
    // max(10, 50) = 50; only 12 in the last hour → not spiking.
    seedEvents(issue.id, NOW - 2 * HOUR, 240);
    seedEvents(issue.id, NOW - 30 * 60_000, 12);

    expect(sweepSpikes(db, NOW)).toBe(0);
    expect(getIssue(db, issue.id)?.spikeActive).toBe(false);
    expect(spikeDispatches(NOW + 1)).toHaveLength(0);
  });

  it('does not fire for a resolved issue even with a burst', () => {
    const issue = seedIssue(NOW);
    seedEvents(issue.id, NOW - 10 * 60_000, 30);
    // 'resolved' is not an enterable status, so no spike despite the volume.
    setIssueStatus(db, issue.id, 'resolved');
    expect(sweepSpikes(db, NOW)).toBe(0);
    expect(getIssue(db, issue.id)?.spikeActive).toBe(false);
  });
});

describe('startSpikeSweep', () => {
  it('runs a sweep via sweepOnce and stops cleanly', () => {
    const issue = seedIssue(NOW);
    seedEvents(issue.id, NOW - 20 * 60_000, 15);
    const handle = startSpikeSweep({ db, intervalMs: 1_000_000 });
    try {
      expect(handle.sweepOnce(NOW)).toBe(1);
      expect(getIssue(db, issue.id)?.spikeActive).toBe(true);
    } finally {
      handle.stop();
    }
  });
});
