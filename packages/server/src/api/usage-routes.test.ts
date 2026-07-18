import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { insertUsageEvent } from '../db/repos/usage.js';
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
afterEach(() => close());

const authHeader = () => ({ authorization: `Bearer ${token}` });
const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });

const seed = () => {
  const now = Date.now();
  insertUsageEvent(db, {
    projectId: project.id,
    type: 'pageview',
    name: null,
    path: '/home',
    referrerDomain: 'google.com',
    visitor: 'v1',
    props: null,
    receivedAt: now,
  });
  insertUsageEvent(db, {
    projectId: project.id,
    type: 'event',
    name: 'signup',
    path: null,
    referrerDomain: null,
    visitor: 'v1',
    props: null,
    receivedAt: now,
  });
};

describe('GET /api/projects/:id/usage/summary', () => {
  it('requires a JWT (401 without one)', async () => {
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/usage/summary`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s for an unknown project', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/projects/nope/usage/summary',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns the full summary shape with default 30 days', async () => {
    seed();
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/usage/summary`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      days: unknown[];
      topPages: unknown[];
      topReferrers: Array<{ referrer: string; pageviews: number }>;
      topEvents: Array<{ name: string; count: number }>;
      totals: { pageviews: number; visitors: number; events: number };
    }>();
    expect(body.days).toHaveLength(30);
    expect(body.totals).toEqual({ pageviews: 1, visitors: 1, events: 1 });
    expect(body.topReferrers[0]).toEqual({ referrer: 'google.com', pageviews: 1 });
    expect(body.topEvents[0]).toEqual({ name: 'signup', count: 1 });
    // The summary must never expose a visitor hash or salt.
    expect(res.body).not.toContain('v1');
  });

  it('clamps days to 1..90', async () => {
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/usage/summary?days=1000`,
      headers: authHeader(),
    });
    expect(res.json<{ days: unknown[] }>().days).toHaveLength(90);
  });
});
