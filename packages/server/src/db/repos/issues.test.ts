import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { getIssue, listIssues, markIssueAlerted, setIssueStatus, upsertIssue } from './issues.js';

let db: Db;
let close: () => void;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  projectId = createProject(db, { name: 'App' }).id;
});

afterEach(() => {
  close();
});

describe('issues repo', () => {
  it('upsertIssue creates new issue on first call', () => {
    const r = upsertIssue(db, {
      projectId,
      fingerprint: 'TypeError::App.tsx:render',
      title: "TypeError: Cannot read 'x'",
      ts: 1_000,
    });
    expect(r.isNew).toBe(true);
    expect(r.issue.eventCount).toBe(1);
    expect(r.issue.firstSeen).toBe(1_000);
    expect(r.issue.lastSeen).toBe(1_000);
    expect(r.issue.status).toBe('open');
  });

  it('upsertIssue increments existing on repeat', () => {
    upsertIssue(db, { projectId, fingerprint: 'fp1', title: 't', ts: 1_000 });
    const second = upsertIssue(db, { projectId, fingerprint: 'fp1', title: 't', ts: 2_000 });
    expect(second.isNew).toBe(false);
    expect(second.issue.eventCount).toBe(2);
    expect(second.issue.firstSeen).toBe(1_000);
    expect(second.issue.lastSeen).toBe(2_000);
  });

  it('upsertIssue isolates by project', () => {
    const p2 = createProject(db, { name: 'App2' }).id;
    const a = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    const b = upsertIssue(db, { projectId: p2, fingerprint: 'fp', title: 't', ts: 1 });
    expect(b.isNew).toBe(true);
    expect(a.issue.id).not.toBe(b.issue.id);
  });

  it('listIssues orders by lastSeen desc', () => {
    upsertIssue(db, { projectId, fingerprint: 'a', title: 'A', ts: 1_000 });
    upsertIssue(db, { projectId, fingerprint: 'b', title: 'B', ts: 3_000 });
    upsertIssue(db, { projectId, fingerprint: 'c', title: 'C', ts: 2_000 });
    const { rows, total } = listIssues(db, { projectId });
    expect(total).toBe(3);
    expect(rows.map((r) => r.title)).toEqual(['B', 'C', 'A']);
  });

  it('listIssues filters by status', () => {
    const a = upsertIssue(db, { projectId, fingerprint: 'a', title: 'A', ts: 1 });
    const b = upsertIssue(db, { projectId, fingerprint: 'b', title: 'B', ts: 1 });
    setIssueStatus(db, a.issue.id, 'resolved');
    const open = listIssues(db, { projectId, status: 'open' });
    expect(open.total).toBe(1);
    expect(open.rows[0]?.id).toBe(b.issue.id);
  });

  it('listIssues paginates with limit + offset', () => {
    for (let i = 0; i < 5; i++) {
      upsertIssue(db, { projectId, fingerprint: `fp${String(i)}`, title: 't', ts: i });
    }
    const page1 = listIssues(db, { projectId, limit: 2, offset: 0 });
    const page2 = listIssues(db, { projectId, limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
  });

  it('setIssueStatus flips status', () => {
    const { issue } = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    const updated = setIssueStatus(db, issue.id, 'resolved');
    expect(updated?.status).toBe('resolved');
  });

  it('setIssueStatus returns null for missing issue', () => {
    expect(setIssueStatus(db, 'nope', 'resolved')).toBeNull();
  });

  it('markIssueAlerted sets lastAlertedAt', () => {
    const { issue } = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    markIssueAlerted(db, issue.id, 5_000);
    expect(getIssue(db, issue.id)?.lastAlertedAt).toBe(5_000);
  });
});

describe('upsertIssue — regression transition (resolved -> regressed)', () => {
  it('a new event on a resolved issue transitions it to regressed (once)', () => {
    const { issue } = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    setIssueStatus(db, issue.id, 'resolved');

    const second = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 2 });
    expect(second.regressed).toBe(true);
    expect(second.issue.status).toBe('regressed');

    // A further event on the now-regressed issue does NOT re-fire the transition.
    const third = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 3 });
    expect(third.regressed).toBe(false);
    expect(third.issue.status).toBe('regressed');
    expect(third.issue.eventCount).toBe(3);
  });

  it('an open issue stays open (no regression)', () => {
    upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    const second = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 2 });
    expect(second.regressed).toBe(false);
    expect(second.issue.status).toBe('open');
  });

  it('an ignored issue stays ignored (no regression)', () => {
    const { issue } = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    setIssueStatus(db, issue.id, 'ignored');
    const second = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 2 });
    expect(second.regressed).toBe(false);
    expect(second.issue.status).toBe('ignored');
  });

  it('a fresh issue is never regressed', () => {
    const r = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    expect(r.regressed).toBe(false);
    expect(r.isNew).toBe(true);
  });

  it('re-resolving a regressed issue re-arms detection', () => {
    const { issue } = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 1 });
    setIssueStatus(db, issue.id, 'resolved');
    const regressed = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 2 });
    expect(regressed.regressed).toBe(true);

    // User PATCHes it back to resolved → the next event regresses it again.
    setIssueStatus(db, issue.id, 'resolved');
    const again = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 3 });
    expect(again.regressed).toBe(true);
    expect(again.issue.status).toBe('regressed');
  });
});
