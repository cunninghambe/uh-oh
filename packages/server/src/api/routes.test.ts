import type { EventEnvelope } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import type { ProjectRow, IssueRow, EventRow, BreadcrumbRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;
let token: string;

const envelope: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'cannot x',
    stacktrace: [{ module: 'src/A.tsx', function: 'render', inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [
    {
      ts: '2026-05-16T11:59:50.000Z',
      category: 'nav',
      level: 'info',
      message: 'home',
    },
  ],
  device: { osName: 'Android', osVersion: '14' },
};

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  token = await mintTestToken(db);
});

afterEach(() => {
  close();
});

const authHeader = () => ({ authorization: `Bearer ${token}` });

const seedEvent = async (app: ReturnType<typeof buildServer>) => {
  const r = await app.inject({
    method: 'POST',
    url: `/ingest/${project.publicKey}`,
    payload: envelope,
  });
  return r.json<{ eventId: string }>();
};

const buildTestServer = (testDb: Db) =>
  buildServer({ db: testDb, secret: TEST_SECRET, password: 'test-password' });

describe('GET /api/projects', () => {
  it('returns empty array when no projects', async () => {
    const fresh = makeTestDb();
    const freshToken = await mintTestToken(fresh.db);
    const app = buildTestServer(fresh.db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${freshToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ projects: ProjectRow[] }>().projects).toEqual([]);
    fresh.close();
  });

  it('returns project list', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: authHeader(),
    });
    expect(res.json<{ projects: ProjectRow[] }>().projects).toHaveLength(1);
  });

  it('returns 401 without Authorization header', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/projects', () => {
  it('creates a project', async () => {
    const fresh = makeTestDb();
    const freshToken = await mintTestToken(fresh.db);
    const app = buildTestServer(fresh.db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'New App' },
      headers: { authorization: `Bearer ${freshToken}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ project: ProjectRow }>().project.slug).toBe('new-app');
    fresh.close();
  });

  it('rejects empty name', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-object body', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: '42',
      headers: { 'content-type': 'application/json', ...authHeader() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('updates webhookUrl', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { webhookUrl: 'https://hooks.example/x' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ project: ProjectRow }>().project.webhookUrl).toBe('https://hooks.example/x');
  });

  it('rejects invalid alertDedupeMinutes', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { alertDedupeMinutes: -1 },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an SSRF webhook URL (loopback IP)', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { webhookUrl: 'http://127.0.0.1/hook' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_webhookUrl');
  });

  it('rejects a non-http(s) webhook URL scheme', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { webhookUrl: 'ftp://example.com/hook' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('allows clearing the webhook URL with null', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${project.id}`,
      payload: { webhookUrl: null },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ project: ProjectRow }>().project.webhookUrl).toBeNull();
  });

  it('404 on missing project', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/nope',
      payload: { webhookUrl: 'https://hooks.example.com/x' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/rotate-key', () => {
  it('returns new public key', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/rotate-key`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ project: ProjectRow }>().project.publicKey).not.toBe(project.publicKey);
  });
});

describe('GET /api/projects/:id/issues', () => {
  it('lists issues for project', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ issues: IssueRow[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.issues[0]?.title).toContain('TypeError');
    // §CONTRACT P: the list payload carries the issue's latest platform.
    expect(body.issues[0]?.platform).toBe('android');
  });

  it('filters by status', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?status=resolved`,
      headers: authHeader(),
    });
    expect(res.json<{ total: number }>().total).toBe(0);
  });

  it('404 on missing project', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/nope/issues',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/issues/:id', () => {
  it('returns issue + latest event + breadcrumbs', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    const issueId = list.json<{ issues: IssueRow[] }>().issues[0]?.id;
    const res = await app.inject({
      method: 'GET',
      url: `/api/issues/${issueId ?? ''}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      issue: IssueRow;
      latestEvent: EventRow | null;
      breadcrumbs: BreadcrumbRow[];
    }>();
    expect(body.issue.id).toBe(issueId);
    // §CONTRACT P: the issue detail payload carries platform (nullable).
    expect(body.issue.platform).toBe('android');
    expect(body.latestEvent?.platform).toBe('android');
    expect(body.breadcrumbs).toHaveLength(1);
  });

  it('404 on missing issue', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/issues/nope',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/events/:id', () => {
  it('returns event + breadcrumbs without symbolicate param', async () => {
    const app = buildTestServer(db);
    const { eventId } = await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/events/${eventId}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ event: EventRow; breadcrumbs: BreadcrumbRow[]; frames?: unknown[] }>();
    expect(body.event.id).toBe(eventId);
    expect(body.frames).toBeUndefined();
  });

  it('returns frames array when symbolicate=true', async () => {
    const app = buildTestServer(db);
    const { eventId } = await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/events/${eventId}?symbolicate=true`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ event: EventRow; breadcrumbs: BreadcrumbRow[]; frames: unknown[] }>();
    expect(Array.isArray(body.frames)).toBe(true);
  });

  it('404 on missing event', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/events/no-such-event',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/issues/:id', () => {
  it('flips status', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const list = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    const issueId = list.json<{ issues: IssueRow[] }>().issues[0]?.id ?? '';
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/issues/${issueId}`,
      payload: { status: 'resolved' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ issue: IssueRow }>().issue.status).toBe('resolved');
  });

  it('rejects invalid status', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/issues/x',
      payload: { status: 'nope' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('returns 204 and removes project', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 on repeat delete', async () => {
    const app = buildTestServer(db);
    await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: authHeader(),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('cascades: related issues and events removed', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const listBefore = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    expect(listBefore.json<{ total: number }>().total).toBe(1);

    await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
      headers: authHeader(),
    });

    // Project gone
    const getProject = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}`,
      headers: authHeader(),
    });
    expect(getProject.statusCode).toBe(404);
  });
});

describe('GET /api/projects/:id/issues?sort=', () => {
  it('defaults to lastSeen desc', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ issues: IssueRow[] }>().issues).toHaveLength(1);
  });

  it('sort=lastSeen accepted', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?sort=lastSeen`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('sort=eventCount accepted', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?sort=eventCount`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('sort=firstSeen accepted', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?sort=firstSeen`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('invalid sort returns 400', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?sort=badField`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('sort=eventCount orders correctly', async () => {
    // Two issues with different event counts
    const ts = Date.now();
    const issue1 = upsertIssue(db, {
      projectId: project.id,
      fingerprint: 'fp-a',
      title: 'A',
      ts,
    }).issue;
    upsertIssue(db, { projectId: project.id, fingerprint: 'fp-a', title: 'A', ts }); // bump count
    const issue2 = upsertIssue(db, {
      projectId: project.id,
      fingerprint: 'fp-b',
      title: 'B',
      ts,
    }).issue;

    // issue1 has eventCount=2, issue2 has eventCount=1
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?sort=eventCount`,
      headers: authHeader(),
    });
    const body = res.json<{ issues: IssueRow[] }>();
    expect(body.issues[0]?.id).toBe(issue1.id);
    expect(body.issues[1]?.id).toBe(issue2.id);
  });
});

describe('GET /api/issues/:id/events total', () => {
  it('returns events and total', async () => {
    const app = buildTestServer(db);
    const { eventId } = await seedEvent(app);
    const issueList = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    const issueId = issueList.json<{ issues: IssueRow[] }>().issues[0]?.id ?? '';
    const res = await app.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/events`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: EventRow[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.events[0]?.id).toBe(eventId);
  });

  it('supports SPEC §9 page= (1-indexed) pagination', async () => {
    const app = buildTestServer(db);
    await seedEvent(app);
    await seedEvent(app);
    await seedEvent(app);
    const issueList = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: authHeader(),
    });
    const issueId = issueList.json<{ issues: IssueRow[] }>().issues[0]?.id ?? '';
    const page1 = await app.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/events?page=1&limit=2`,
      headers: authHeader(),
    });
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/events?page=2&limit=2`,
      headers: authHeader(),
    });
    const b1 = page1.json<{ events: EventRow[]; total: number }>();
    const b2 = page2.json<{ events: EventRow[]; total: number }>();
    expect(b1.total).toBe(3);
    expect(b1.events).toHaveLength(2);
    expect(b2.events).toHaveLength(1);
    const ids = [...b1.events, ...b2.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });
});
