import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue } from './issues.js';
import { insertEvent } from './events.js';
import { enqueueDispatch, takeDueDispatches, markDispatchAttempt } from './webhook-dispatches.js';

let db: Db;
let close: () => void;
let issueId: string;
let eventId: string;

const NOW = 1_000_000;
const WEBHOOK_URL = 'https://hooks.example/test';

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'Test', webhookUrl: WEBHOOK_URL });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: 'fp1',
    title: 'Test error',
    ts: NOW,
  });
  issueId = issue.id;
  const event = insertEvent(db, {
    projectId: project.id,
    issueId: issue.id,
    releaseId: null,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'android',
    payload: '{}',
    receivedAt: NOW,
    deviceInfo: '{}',
    userInfo: null,
  });
  eventId = event.id;
});

afterEach(() => {
  close();
});

describe('enqueueDispatch', () => {
  it('creates row with status=pending, attempt=0, nextAttemptAt=now', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    expect(row.status).toBe('pending');
    expect(row.attempt).toBe(0);
    expect(row.nextAttemptAt).toBe(NOW);
    expect(row.lastError).toBeNull();
    expect(row.lastResponseCode).toBeNull();
    expect(row.createdAt).toBe(NOW);
  });
});

describe('takeDueDispatches', () => {
  it('returns rows where nextAttemptAt <= now AND status=pending, up to limit', () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    const due = takeDueDispatches(db, NOW, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.issueId).toBe(issueId);
  });

  it('excludes rows with nextAttemptAt > now', () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW + 5000);
    const due = takeDueDispatches(db, NOW, 10);
    expect(due).toHaveLength(0);
  });

  it('excludes succeeded rows', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    markDispatchAttempt(db, row.id, { ok: true, statusCode: 200, at: NOW });
    const due = takeDueDispatches(db, NOW, 10);
    expect(due).toHaveLength(0);
  });

  it('excludes failed rows', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    markDispatchAttempt(db, row.id, {
      ok: false,
      statusCode: null,
      error: 'timeout',
      at: NOW,
      nextAttemptAt: null,
    });
    const due = takeDueDispatches(db, NOW, 10);
    expect(due).toHaveLength(0);
  });

  it('respects limit', () => {
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    const due = takeDueDispatches(db, NOW, 2);
    expect(due).toHaveLength(2);
  });
});

describe('markDispatchAttempt', () => {
  it('ok:true sets status=succeeded and lastResponseCode', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    markDispatchAttempt(db, row.id, { ok: true, statusCode: 200, at: NOW });
    const after = takeDueDispatches(db, NOW, 10);
    expect(after).toHaveLength(0); // succeeded rows excluded
  });

  it('ok:false with nextAttemptAt=null sets status=failed', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    markDispatchAttempt(db, row.id, {
      ok: false,
      statusCode: 500,
      error: 'server error',
      at: NOW,
      nextAttemptAt: null,
    });
    const due = takeDueDispatches(db, NOW + 999999, 10);
    expect(due).toHaveLength(0); // failed rows excluded at any time
  });

  it('ok:false with nextAttemptAt keeps pending and bumps attempt', () => {
    const row = enqueueDispatch(db, { issueId, eventId, url: WEBHOOK_URL }, NOW);
    markDispatchAttempt(db, row.id, {
      ok: false,
      statusCode: 503,
      error: 'unavailable',
      at: NOW,
      nextAttemptAt: NOW + 2000,
    });
    // Not due yet at NOW
    const notDue = takeDueDispatches(db, NOW, 10);
    expect(notDue).toHaveLength(0);
    // Due at NOW+2000
    const due = takeDueDispatches(db, NOW + 2000, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.attempt).toBe(1);
    expect(due[0]?.lastError).toBe('unavailable');
    expect(due[0]?.lastResponseCode).toBe(503);
  });
});
