import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;
let token: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  token = await mintTestToken(db);
});
afterEach(() => {
  close();
});

const authHeader = () => ({ authorization: `Bearer ${token}` });
const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const todayUtc = () => new Date().toISOString().slice(0, 10);

const seedIssueWithEvents = (n: number): string => {
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${Math.random()}`,
    title: 't',
    ts: Date.now(),
  });
  for (let i = 0; i < n; i++) {
    insertEvent(db, {
      projectId: project.id,
      issueId: issue.id,
      releaseId: null,
      fingerprint: 'fp',
      level: 'error',
      platform: 'web',
      payload: '{}',
      receivedAt: Date.now(),
      deviceInfo: '{}',
      userInfo: null,
    });
  }
  return issue.id;
};

describe('GET /api/projects/:id/stats', () => {
  it('requires auth', async () => {
    const res = await app().inject({ method: 'GET', url: `/api/projects/${project.id}/stats` });
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown project', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/projects/nope/stats',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a zero-filled day series (default 14) plus totalOpenIssues', async () => {
    seedIssueWithEvents(3);
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/stats`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      days: { date: string; events: number }[];
      totalOpenIssues: number;
    }>();
    expect(body.days).toHaveLength(14);
    expect(body.days[13]?.date).toBe(todayUtc());
    expect(body.days[13]?.events).toBe(3);
    expect(body.totalOpenIssues).toBe(1);
    // Ascending order.
    const dates = body.days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('clamps days to 1..90', async () => {
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/stats?days=1000`,
      headers: authHeader(),
    });
    expect(res.json<{ days: unknown[] }>().days).toHaveLength(90);

    const res2 = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/stats?days=0`,
      headers: authHeader(),
    });
    expect(res2.json<{ days: unknown[] }>().days).toHaveLength(1);
  });
});

describe('GET /api/issues/:id/stats', () => {
  it('404 for an unknown issue', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/issues/nope/stats',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a day series for the issue', async () => {
    const issueId = seedIssueWithEvents(2);
    const res = await app().inject({
      method: 'GET',
      url: `/api/issues/${issueId}/stats?days=7`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ days: { date: string; events: number }[] }>();
    expect(body.days).toHaveLength(7);
    expect(body.days[6]?.date).toBe(todayUtc());
    expect(body.days[6]?.events).toBe(2);
    expect(body).not.toHaveProperty('totalOpenIssues');
  });
});
