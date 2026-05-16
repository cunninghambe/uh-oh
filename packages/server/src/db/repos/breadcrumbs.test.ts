import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue } from './issues.js';
import { insertEvent } from './events.js';
import { insertBreadcrumbs, listBreadcrumbs } from './breadcrumbs.js';

let db: Db;
let close: () => void;
let eventId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const projectId = createProject(db, { name: 'App' }).id;
  const issueId = upsertIssue(db, { projectId, fingerprint: 'fp', title: 't', ts: 0 }).issue.id;
  eventId = insertEvent(db, {
    projectId,
    issueId,
    releaseId: null,
    fingerprint: 'fp',
    level: 'error',
    platform: 'android',
    payload: '{}',
    receivedAt: 1_000,
    deviceInfo: '{}',
    userInfo: null,
  }).id;
});

afterEach(() => {
  close();
});

describe('breadcrumbs repo', () => {
  it('insertBreadcrumbs persists with sequential idx', () => {
    insertBreadcrumbs(db, eventId, [
      { ts: 1, category: 'nav', level: 'info', message: 'a', data: null },
      { ts: 2, category: 'nav', level: 'info', message: 'b', data: null },
      { ts: 3, category: 'log', level: 'warning', message: 'c', data: '{"x":1}' },
    ]);
    const rows = listBreadcrumbs(db, eventId);
    expect(rows.map((r) => r.idx)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.message)).toEqual(['a', 'b', 'c']);
  });

  it('insertBreadcrumbs is a no-op on empty array', () => {
    insertBreadcrumbs(db, eventId, []);
    expect(listBreadcrumbs(db, eventId)).toHaveLength(0);
  });

  it('listBreadcrumbs orders by idx asc', () => {
    insertBreadcrumbs(db, eventId, [
      { ts: 3, category: 'a', level: 'info', message: 'first', data: null },
      { ts: 1, category: 'a', level: 'info', message: 'second', data: null },
    ]);
    const rows = listBreadcrumbs(db, eventId);
    expect(rows.map((r) => r.message)).toEqual(['first', 'second']);
  });
});
