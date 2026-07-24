import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue, getIssue } from './issues.js';
import { insertEvent } from './events.js';
import { insertBreadcrumbs, listBreadcrumbs } from './breadcrumbs.js';
import { enqueueDispatch, markDispatchAttempt } from './webhook-dispatches.js';
import { insertUsageEvent } from './usage.js';
import { createAnnotation } from './annotations.js';
import { upsertFixAttempt } from './fix-attempts.js';
import {
  events,
  fixAttempts,
  issueAnnotations,
  symbolications,
  usageEvents,
  usageSalts,
  webhookDispatches,
} from '../schema.js';
import { pruneOldData, resolveRetentionDays } from './retention.js';

const DAY = 86_400_000;
const NOW = 2_000_000_000_000;

let db: Db;
let close: () => void;
let projectId: string;
let issueId: string;

const seedEvent = (receivedAt: number): string => {
  const event = insertEvent(db, {
    projectId,
    issueId,
    releaseId: null,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'android',
    payload: '{}',
    receivedAt,
    deviceInfo: '{}',
    userInfo: null,
  });
  return event.id;
};

const eventExists = (eventId: string): boolean =>
  db.select().from(events).where(eq(events.id, eventId)).get() !== undefined;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'App' });
  projectId = project.id;
  issueId = upsertIssue(db, { projectId, fingerprint: 'fp1', title: 't', ts: NOW }).issue.id;
});

afterEach(() => {
  close();
});

describe('pruneOldData', () => {
  it('deletes events older than the retention window and keeps young ones', () => {
    const oldEvent = seedEvent(NOW - 100 * DAY);
    const youngEvent = seedEvent(NOW - 1 * DAY);

    const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

    expect(res.eventsDeleted).toBe(1);
    expect(eventExists(youngEvent)).toBe(true);
    expect(eventExists(oldEvent)).toBe(false);
  });

  it('cascades breadcrumbs and symbolications when an event is pruned', () => {
    const oldEvent = seedEvent(NOW - 100 * DAY);
    insertBreadcrumbs(db, oldEvent, [
      { ts: NOW - 100 * DAY, category: 'nav', level: 'info', message: 'x', data: null },
    ]);
    db.insert(symbolications)
      .values({ eventId: oldEvent, frameIdx: 0, resolved: JSON.stringify({ status: 'ok' }) })
      .run();

    expect(listBreadcrumbs(db, oldEvent)).toHaveLength(1);

    pruneOldData(db, { now: NOW, retentionDays: 90 });

    expect(listBreadcrumbs(db, oldEvent)).toHaveLength(0);
    expect(
      db.select().from(symbolications).where(eq(symbolications.eventId, oldEvent)).all(),
    ).toHaveLength(0);
  });

  it('retentionDays = 0 disables event pruning', () => {
    const oldEvent = seedEvent(NOW - 1000 * DAY);
    const res = pruneOldData(db, { now: NOW, retentionDays: 0 });
    expect(res.eventsDeleted).toBe(0);
    expect(eventExists(oldEvent)).toBe(true);
  });

  it('never prunes issues', () => {
    seedEvent(NOW - 100 * DAY);
    pruneOldData(db, { now: NOW, retentionDays: 90 });
    expect(getIssue(db, issueId)).not.toBeNull();
  });

  it('prunes terminal dispatches older than 7 days, keeps young and pending', () => {
    const eventId = seedEvent(NOW - 1 * DAY);

    // Old succeeded dispatch (created 10d ago) → pruned
    const oldSucceeded = enqueueDispatch(db, { issueId, eventId, url: 'x' }, NOW - 10 * DAY);
    markDispatchAttempt(db, oldSucceeded.id, { ok: true, statusCode: 200, at: NOW - 10 * DAY });

    // Old failed dispatch (created 10d ago) → pruned
    const oldFailed = enqueueDispatch(db, { issueId, eventId, url: 'y' }, NOW - 10 * DAY);
    markDispatchAttempt(db, oldFailed.id, {
      ok: false,
      statusCode: 500,
      error: 'boom',
      at: NOW - 10 * DAY,
      nextAttemptAt: null,
    });

    // Young succeeded dispatch (created 1d ago) → kept
    const youngSucceeded = enqueueDispatch(db, { issueId, eventId, url: 'z' }, NOW - 1 * DAY);
    markDispatchAttempt(db, youngSucceeded.id, { ok: true, statusCode: 200, at: NOW - 1 * DAY });

    // Old but still pending dispatch (created 10d ago) → kept (not terminal)
    enqueueDispatch(db, { issueId, eventId, url: 'p' }, NOW - 10 * DAY);

    const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

    expect(res.dispatchesDeleted).toBe(2);
    const rows = db.select().from(webhookDispatches).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'succeeded']);
  });

  const seedUsage = (path: string, receivedAt: number): void => {
    insertUsageEvent(db, {
      projectId,
      type: 'pageview',
      name: null,
      path,
      referrerDomain: null,
      visitor: 'v',
      props: null,
      receivedAt,
    });
  };

  it('prunes usage_events older than the retention window and old daily salts', () => {
    seedUsage('/old', NOW - 100 * DAY);
    seedUsage('/young', NOW - 1 * DAY);
    const oldDate = new Date(NOW - 10 * DAY).toISOString().slice(0, 10);
    const recentDate = new Date(NOW).toISOString().slice(0, 10);
    db.insert(usageSalts).values({ date: oldDate, salt: 'old' }).run();
    db.insert(usageSalts).values({ date: recentDate, salt: 'new' }).run();

    const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

    expect(res.usageEventsDeleted).toBe(1);
    expect(res.usageSaltsDeleted).toBe(1);
    expect(
      db
        .select()
        .from(usageEvents)
        .all()
        .map((r) => r.path),
    ).toEqual(['/young']);
    expect(
      db
        .select()
        .from(usageSalts)
        .all()
        .map((r) => r.date),
    ).toEqual([recentDate]);
  });

  it('retentionDays = 0 disables usage_events pruning', () => {
    seedUsage('/ancient', NOW - 1000 * DAY);
    const res = pruneOldData(db, { now: NOW, retentionDays: 0 });
    expect(res.usageEventsDeleted).toBe(0);
    expect(db.select().from(usageEvents).all()).toHaveLength(1);
  });

  // §23 agent-loop tables. They are agent-writable and were previously never
  // pruned at all, so they grew forever; they are the institutional memory the
  // agent loop exists to build, so they only die WITH their issue.
  describe('issue_annotations + fix_attempts (dead issues only)', () => {
    let liveIssueId: string;

    const seedAgentRows = (issue: string, tag: string): void => {
      createAnnotation(db, { issueId: issue, body: `note ${tag}` }, NOW - 50 * DAY);
      upsertFixAttempt(db, { issueId: issue, prUrl: `https://gh/pr/${tag}` }, NOW - 50 * DAY);
    };

    const seedLiveEvent = (): string =>
      insertEvent(db, {
        projectId,
        issueId: liveIssueId,
        releaseId: null,
        fingerprint: 'fp-live',
        level: 'error',
        platform: 'android',
        payload: '{}',
        receivedAt: NOW - 1 * DAY,
        deviceInfo: '{}',
        userInfo: null,
      }).id;

    beforeEach(() => {
      // A second issue that always keeps a young event, so it is LIVE in every
      // case below. `issueId` (from the outer beforeEach) is the variable one.
      liveIssueId = upsertIssue(db, {
        projectId,
        fingerprint: 'fp-live',
        title: 'live',
        ts: NOW,
      }).issue.id;
      seedAgentRows(issueId, 'dead');
      seedAgentRows(liveIssueId, 'live');
    });

    const annotationIssueIds = (): string[] =>
      db
        .select()
        .from(issueAnnotations)
        .all()
        .map((r) => r.issueId);
    const fixAttemptIssueIds = (): string[] =>
      db
        .select()
        .from(fixAttempts)
        .all()
        .map((r) => r.issueId);

    it('drops annotations and fix attempts for issues left with no events, keeps live ones', () => {
      seedEvent(NOW - 100 * DAY); // the other issue's only event: pruned
      const youngEvent = seedLiveEvent();

      const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

      expect(res.annotationsDeleted).toBe(1);
      expect(res.fixAttemptsDeleted).toBe(1);
      expect(annotationIssueIds()).toEqual([liveIssueId]);
      expect(fixAttemptIssueIds()).toEqual([liveIssueId]);
      expect(eventExists(youngEvent)).toBe(true);
      // The issue rows themselves are still never pruned.
      expect(getIssue(db, issueId)).not.toBeNull();
    });

    it('keeps annotations for an issue whose events are all still inside the window', () => {
      seedEvent(NOW - 1 * DAY); // young, so this issue survives the prune too
      seedLiveEvent();

      const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

      expect(res.annotationsDeleted).toBe(0);
      expect(res.fixAttemptsDeleted).toBe(0);
      expect(annotationIssueIds().sort()).toEqual([issueId, liveIssueId].sort());
      expect(fixAttemptIssueIds().sort()).toEqual([issueId, liveIssueId].sort());
    });

    it('keeps annotations when only SOME events of an issue age out', () => {
      seedEvent(NOW - 100 * DAY); // pruned
      seedEvent(NOW - 2 * DAY); // survives, so the issue stays live
      seedLiveEvent();

      const res = pruneOldData(db, { now: NOW, retentionDays: 90 });

      expect(res.eventsDeleted).toBe(1);
      expect(res.annotationsDeleted).toBe(0);
      expect(annotationIssueIds().sort()).toEqual([issueId, liveIssueId].sort());
    });

    it('retentionDays = 0 disables agent-table pruning entirely', () => {
      // No events at all, so both issues look dead, but pruning is off.
      const res = pruneOldData(db, { now: NOW, retentionDays: 0 });
      expect(res.annotationsDeleted).toBe(0);
      expect(res.fixAttemptsDeleted).toBe(0);
      expect(db.select().from(issueAnnotations).all()).toHaveLength(2);
      expect(db.select().from(fixAttempts).all()).toHaveLength(2);
    });
  });
});

describe('resolveRetentionDays', () => {
  it('defaults to 90 when unset', () => {
    expect(resolveRetentionDays(undefined)).toBe(90);
    expect(resolveRetentionDays('')).toBe(90);
  });

  it('parses a valid integer', () => {
    expect(resolveRetentionDays('30')).toBe(30);
    expect(resolveRetentionDays('0')).toBe(0);
  });

  it('falls back to default on invalid input', () => {
    expect(resolveRetentionDays('-5')).toBe(90);
    expect(resolveRetentionDays('abc')).toBe(90);
    expect(resolveRetentionDays('1.5')).toBe(90);
  });
});
