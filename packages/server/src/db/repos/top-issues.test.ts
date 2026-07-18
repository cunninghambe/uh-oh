import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { setIssueStatus, upsertIssue } from './issues.js';
import { insertEvent } from './events.js';
import { topIssues } from './top-issues.js';
import type { IssueStatus } from './issues.js';

let db: Db;
let close: () => void;

const NOW = Date.UTC(2026, 6, 17, 12, 0, 0); // fixed clock
const DAY = 86_400_000;

beforeEach(() => {
  ({ db, close } = makeTestDb());
});
afterEach(() => close());

let n = 0;
const makeIssue = (opts: {
  projectName: string;
  status?: IssueStatus;
  windowEvents?: number;
  oldEvents?: number;
}): { issueId: string; projectSlug: string } => {
  const project = createProject(db, { name: opts.projectName });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${n++}`,
    title: `t-${opts.projectName}`,
    ts: NOW,
    platform: 'web',
  });
  const addEvents = (count: number, ts: number): void => {
    for (let i = 0; i < count; i++) {
      insertEvent(db, {
        projectId: project.id,
        issueId: issue.id,
        releaseId: null,
        fingerprint: 'fp',
        level: 'error',
        platform: 'web',
        payload: '{}',
        receivedAt: ts,
        deviceInfo: '{}',
        userInfo: null,
      });
    }
  };
  addEvents(opts.windowEvents ?? 0, NOW - DAY); // inside a 14d window
  addEvents(opts.oldEvents ?? 0, NOW - 40 * DAY); // outside the window
  if (opts.status && opts.status !== 'open') setIssueStatus(db, issue.id, opts.status);
  return { issueId: issue.id, projectSlug: project.slug };
};

describe('topIssues', () => {
  it('ranks open + regressed issues across projects by windowed volume', () => {
    const a = makeIssue({ projectName: 'Alpha', windowEvents: 2 });
    const b = makeIssue({ projectName: 'Bravo', windowEvents: 5 });
    makeIssue({ projectName: 'Charlie', windowEvents: 3, status: 'regressed' });

    const rows = topIssues(db, { limit: 25, days: 14, now: NOW });
    expect(rows.map((r) => r.windowEvents)).toEqual([5, 3, 2]);
    expect(rows[0]?.issueId).toBe(b.issueId);
    expect(rows[2]?.issueId).toBe(a.issueId);
    // Carries project slug + platform + counts.
    expect(rows[0]?.projectSlug).toBe('bravo');
    expect(rows[0]?.platform).toBe('web');
    expect(rows[0]?.eventCount).toBeGreaterThan(0);
  });

  it('excludes resolved and ignored issues', () => {
    makeIssue({ projectName: 'Resolved', windowEvents: 9, status: 'resolved' });
    makeIssue({ projectName: 'Ignored', windowEvents: 9, status: 'ignored' });
    const open = makeIssue({ projectName: 'Open', windowEvents: 1 });
    const rows = topIssues(db, { limit: 25, days: 14, now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issueId).toBe(open.issueId);
  });

  it('ignores events outside the window (issue drops out with only old events)', () => {
    makeIssue({ projectName: 'Stale', windowEvents: 0, oldEvents: 20 });
    const rows = topIssues(db, { limit: 25, days: 14, now: NOW });
    expect(rows).toHaveLength(0);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) makeIssue({ projectName: `P${i}`, windowEvents: i + 1 });
    const rows = topIssues(db, { limit: 2, days: 14, now: NOW });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.windowEvents).toBe(5);
    expect(rows[1]?.windowEvents).toBe(4);
  });
});
