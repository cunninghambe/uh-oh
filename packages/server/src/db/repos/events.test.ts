import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue } from './issues.js';
import { getEvent, getLatestEventForIssue, insertEvent, listEventsForIssue } from './events.js';

let db: Db;
let close: () => void;
let projectId: string;
let issueId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  projectId = createProject(db, { name: 'App' }).id;
  issueId = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 0 }).issue.id;
});

afterEach(() => {
  close();
});

const buildEvent = (overrides: Record<string, unknown> = {}) => ({
  projectId,
  issueId,
  releaseId: null,
  fingerprint: 'fp',
  level: 'error',
  platform: 'android' as const,
  payload: JSON.stringify({ ok: true }),
  receivedAt: 1_000,
  deviceInfo: JSON.stringify({ osName: 'Android', osVersion: '14' }),
  userInfo: null,
  ...overrides,
});

describe('events repo', () => {
  it('insertEvent persists with generated id', () => {
    const ev = insertEvent(db, buildEvent());
    expect(ev.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getEvent(db, ev.id)?.fingerprint).toBe('fp');
  });

  it('getEvent returns null when missing', () => {
    expect(getEvent(db, 'nope')).toBeNull();
  });

  it('listEventsForIssue orders by receivedAt desc', () => {
    insertEvent(db, buildEvent({ receivedAt: 1_000 }));
    insertEvent(db, buildEvent({ receivedAt: 3_000 }));
    insertEvent(db, buildEvent({ receivedAt: 2_000 }));
    const { rows } = listEventsForIssue(db, issueId);
    expect(rows.map((r) => r.receivedAt)).toEqual([3_000, 2_000, 1_000]);
  });

  it('listEventsForIssue returns total count', () => {
    insertEvent(db, buildEvent({ receivedAt: 1_000 }));
    insertEvent(db, buildEvent({ receivedAt: 2_000 }));
    const { rows, total } = listEventsForIssue(db, issueId, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(total).toBe(2);
  });

  it('listEventsForIssue paginates', () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(db, buildEvent({ receivedAt: i }));
    }
    expect(listEventsForIssue(db, issueId, { limit: 2 }).rows).toHaveLength(2);
    expect(listEventsForIssue(db, issueId, { limit: 2, offset: 4 }).rows).toHaveLength(1);
  });

  it('getLatestEventForIssue returns most recent', () => {
    insertEvent(db, buildEvent({ receivedAt: 1_000 }));
    insertEvent(db, buildEvent({ receivedAt: 3_000 }));
    expect(getLatestEventForIssue(db, issueId)?.receivedAt).toBe(3_000);
  });

  it('getLatestEventForIssue returns null when no events', () => {
    expect(getLatestEventForIssue(db, 'nope')).toBeNull();
  });
});
