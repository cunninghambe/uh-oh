import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue, getIssue } from './issues.js';
import { insertEvent } from './events.js';
import { insertBreadcrumbs, listBreadcrumbs } from './breadcrumbs.js';
import { enqueueDispatch, markDispatchAttempt } from './webhook-dispatches.js';
import { events, symbolications, webhookDispatches } from '../schema.js';
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
