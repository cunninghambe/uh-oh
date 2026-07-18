import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue, setIssueStatus } from './issues.js';
import { insertEvent } from './events.js';
import { clampDays, issueStats, projectStats } from './stats.js';

let db: Db;
let close: () => void;
let projectId: string;
let issueId: string;

// Deterministic "now": 2026-07-17 10:00 UTC.
const NOW = Date.UTC(2026, 6, 17, 10, 0, 0);
const dayUtc = (y: number, m: number, d: number, h = 12): number => Date.UTC(y, m, d, h);

beforeEach(() => {
  ({ db, close } = makeTestDb());
  projectId = createProject(db, { name: 'App' }).id;
  issueId = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: NOW }).issue.id;
});
afterEach(() => {
  close();
});

const seed = (receivedAt: number, iid = issueId) =>
  insertEvent(db, {
    projectId,
    issueId: iid,
    releaseId: null,
    fingerprint: 'fp',
    level: 'error',
    platform: 'web',
    payload: '{}',
    receivedAt,
    deviceInfo: '{}',
    userInfo: null,
  });

describe('clampDays', () => {
  it('defaults to 14 for missing/invalid input', () => {
    expect(clampDays(undefined)).toBe(14);
    expect(clampDays('abc')).toBe(14);
  });
  it('clamps to 1..90', () => {
    expect(clampDays('0')).toBe(1);
    expect(clampDays('1000')).toBe(90);
    expect(clampDays('7')).toBe(7);
    expect(clampDays(30)).toBe(30);
  });
});

describe('projectStats', () => {
  it('returns an ascending, zero-filled UTC day series of the requested length', () => {
    seed(dayUtc(2026, 6, 15)); // 2026-07-15
    seed(dayUtc(2026, 6, 15)); // 2026-07-15 (same day, 2 events)
    seed(dayUtc(2026, 6, 17, 1)); // 2026-07-17

    const { days } = projectStats(db, projectId, 14, NOW);
    expect(days).toHaveLength(14);
    // Ascending and ending on the UTC day of NOW.
    expect(days[0]?.date).toBe('2026-07-04');
    expect(days[13]?.date).toBe('2026-07-17');
    const dates = days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates); // already ascending

    const byDate = Object.fromEntries(days.map((d) => [d.date, d.events]));
    expect(byDate['2026-07-15']).toBe(2);
    expect(byDate['2026-07-17']).toBe(1);
    expect(byDate['2026-07-10']).toBe(0); // zero-filled
  });

  it('excludes events older than the window', () => {
    seed(dayUtc(2026, 5, 1)); // 2026-06-01, outside a 14-day window
    const { days } = projectStats(db, projectId, 14, NOW);
    expect(days.reduce((s, d) => s + d.events, 0)).toBe(0);
  });

  it('counts only open issues in totalOpenIssues', () => {
    const open2 = upsertIssue(db, { projectId, fingerprint: 'b', title: 't', ts: NOW }).issue.id;
    const resolved = upsertIssue(db, { projectId, fingerprint: 'c', title: 't', ts: NOW }).issue.id;
    const regressed = upsertIssue(db, { projectId, fingerprint: 'd', title: 't', ts: NOW }).issue
      .id;
    setIssueStatus(db, resolved, 'resolved');
    setIssueStatus(db, regressed, 'regressed');

    const { totalOpenIssues } = projectStats(db, projectId, 14, NOW);
    // issueId (default) + open2 are open; resolved/regressed excluded.
    expect(totalOpenIssues).toBe(2);
    void open2;
  });
});

describe('issueStats', () => {
  it('buckets an issue’s events by UTC day', () => {
    const other = upsertIssue(db, { projectId, fingerprint: 'z', title: 't', ts: NOW }).issue.id;
    seed(dayUtc(2026, 6, 16), issueId);
    seed(dayUtc(2026, 6, 16), other); // different issue — must not count here

    const { days } = issueStats(db, issueId, 7, NOW);
    expect(days).toHaveLength(7);
    const byDate = Object.fromEntries(days.map((d) => [d.date, d.events]));
    expect(byDate['2026-07-16']).toBe(1);
    expect(days[6]?.date).toBe('2026-07-17');
    expect(days[0]?.date).toBe('2026-07-11');
  });
});
