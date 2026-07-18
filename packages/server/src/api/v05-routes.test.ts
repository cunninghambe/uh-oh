import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import type { IssueBundle, IssueImpact, TopIssue } from '@uh-oh/mcp';
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

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const auth = () => ({ authorization: `Bearer ${token}` });

let fp = 0;
const seedIssueWithEvents = (count: number): string => {
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${fp++}`,
    title: 't',
    ts: Date.now(),
    platform: 'web',
  });
  for (let i = 0; i < count; i++) {
    insertEvent(db, {
      projectId: project.id,
      issueId: issue.id,
      releaseId: null,
      fingerprint: 'fp',
      level: 'error',
      platform: 'web',
      payload: JSON.stringify({ release: { version: '1.0.0', build: '1' } }),
      receivedAt: Date.now(),
      deviceInfo: JSON.stringify({ osName: 'linux', osVersion: '1', deviceModel: 'srv' }),
      userInfo: JSON.stringify({ id: `u${i}` }),
    });
  }
  return issue.id;
};

describe('GET /api/issues/:id/impact', () => {
  it('requires auth and 404s on unknown issue', async () => {
    const server = app();
    expect((await server.inject({ method: 'GET', url: '/api/issues/x/impact' })).statusCode).toBe(
      401,
    );
    const nf = await server.inject({ method: 'GET', url: '/api/issues/x/impact', headers: auth() });
    expect(nf.statusCode).toBe(404);
  });

  it('returns the impact roll-up', async () => {
    const issueId = seedIssueWithEvents(3);
    const res = await app().inject({
      method: 'GET',
      url: `/api/issues/${issueId}/impact`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const impact = res.json<IssueImpact>();
    expect(impact.distinctUsers).toBe(3);
    expect(impact.platforms[0]).toEqual({ platform: 'web', events: 3 });
    expect(impact.releases[0]).toEqual({ release: '1.0.0+1', events: 3 });
  });
});

describe('GET /api/issues/:id/bundle', () => {
  it('404s on unknown issue', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/issues/nope/bundle',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns a size-bounded bundle', async () => {
    const issueId = seedIssueWithEvents(2);
    const res = await app().inject({
      method: 'GET',
      url: `/api/issues/${issueId}/bundle`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json<IssueBundle>();
    expect(bundle.issue.id).toBe(issueId);
    expect(bundle.project.slug).toBe(project.slug);
    expect(bundle.truncated).toEqual({ context: false, breadcrumbs: false });
    expect(res.rawPayload.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('GET /api/top-issues', () => {
  it('ranks open/regressed issues across projects and clamps params', async () => {
    seedIssueWithEvents(2);
    seedIssueWithEvents(5);
    const res = await app().inject({
      method: 'GET',
      url: '/api/top-issues?limit=999&days=999',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { issues } = res.json<{ issues: TopIssue[] }>();
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues[0]?.windowEvents).toBe(5);
    expect(issues[0]?.projectSlug).toBe(project.slug);
  });

  it('requires auth', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/top-issues' });
    expect(res.statusCode).toBe(401);
  });
});
