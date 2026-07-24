import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { createMonitor, getMonitor } from '../db/repos/monitors.js';
import type { Monitor } from '@uh-oh/mcp';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;
let token: string;

const NOW = 1_800_000_000_000;
const MIN = 60_000;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  token = await mintTestToken(db);
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const auth = () => ({ authorization: `Bearer ${token}` });

const seedMonitor = (slug: string, interval = 10, grace = 5, createdAt = NOW) =>
  createMonitor(db, {
    projectId: project.id,
    slug,
    intervalMinutes: interval,
    graceMinutes: grace,
    now: createdAt,
  });

describe('GET /api/projects/:id/monitors', () => {
  it('requires auth', async () => {
    const res = await app().inject({ method: 'GET', url: `/api/projects/${project.id}/monitors` });
    expect(res.statusCode).toBe(401);
  });

  it('404s on an unknown project', async () => {
    const res = await app().inject({
      method: 'GET',
      url: '/api/projects/nope/monitors',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists monitors with a computed overdue flag', async () => {
    // created long ago so it is overdue now.
    seedMonitor('cron', 10, 5, Date.now() - 60 * MIN);
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/monitors`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { monitors } = res.json<{ monitors: Monitor[] }>();
    expect(monitors).toHaveLength(1);
    expect(monitors[0]).toMatchObject({ slug: 'cron', overdue: true, projectSlug: project.slug });
  });
});

describe('PATCH /api/monitors/:id', () => {
  it('updates name, cadence, and pause status', async () => {
    const m = seedMonitor('cron');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { name: 'Nightly', intervalMinutes: 30, graceMinutes: 10, status: 'paused' },
    });
    expect(res.statusCode).toBe(200);
    const updated = getMonitor(db, m.id);
    expect(updated).toMatchObject({
      name: 'Nightly',
      intervalMinutes: 30,
      graceMinutes: 10,
      status: 'paused',
    });
    expect(res.json<{ monitor: Monitor }>().monitor.overdue).toBeDefined();
  });

  it('rejects a non user-settable status', async () => {
    const m = seedMonitor('cron');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { status: 'missed' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_status');
  });

  it('rejects an invalid interval', async () => {
    const m = seedMonitor('cron');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { intervalMinutes: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s on an unknown monitor', async () => {
    const res = await app().inject({
      method: 'PATCH',
      url: '/api/monitors/nope',
      headers: auth(),
      payload: { status: 'ok' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/monitors/:id', () => {
  it('deletes an existing monitor', async () => {
    const m = seedMonitor('cron');
    const res = await app().inject({
      method: 'DELETE',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(204);
    expect(getMonitor(db, m.id)).toBeNull();
  });

  it('404s on an unknown monitor', async () => {
    const res = await app().inject({
      method: 'DELETE',
      url: '/api/monitors/nope',
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/monitors (http)', () => {
  const create = (payload: Record<string, unknown>, id = project.id) =>
    app().inject({
      method: 'POST',
      url: `/api/projects/${id}/monitors`,
      headers: auth(),
      payload,
    });

  it('requires auth', async () => {
    const res = await app().inject({
      method: 'POST',
      url: `/api/projects/${project.id}/monitors`,
      payload: { kind: 'http', slug: 'ops', url: 'https://err.example', intervalMinutes: 5 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates an http monitor and surfaces kind/url/lastProbeStatus', async () => {
    const res = await create({
      kind: 'http',
      slug: 'ops',
      url: 'https://err.example/health',
      intervalMinutes: 5,
      timeoutMs: 8000,
    });
    expect(res.statusCode).toBe(201);
    const { monitor } = res.json<{ monitor: Monitor & { kind: string; url: string } }>();
    expect(monitor).toMatchObject({
      slug: 'ops',
      kind: 'http',
      url: 'https://err.example/health',
      status: 'ok',
      overdue: false,
    });
    // It shows up in the list with the http fields.
    const list = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/monitors`,
      headers: auth(),
    });
    const row = list
      .json<{
        monitors: (Monitor & { kind: string; url: string; lastProbeStatus: number | null })[];
      }>()
      .monitors.find((m) => m.slug === 'ops');
    expect(row).toMatchObject({
      kind: 'http',
      url: 'https://err.example/health',
      lastProbeStatus: null,
    });
  });

  it('caps an over-large timeout at 30000', async () => {
    const res = await create({
      kind: 'http',
      slug: 'slow',
      url: 'https://err.example',
      intervalMinutes: 5,
      timeoutMs: 999999,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ monitor: { timeoutMs: number } }>().monitor.timeoutMs).toBe(30000);
  });

  it('rejects a non-http kind (check-in monitors auto-create via ping)', async () => {
    const res = await create({ kind: 'checkin', slug: 'cron', intervalMinutes: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_kind');
  });

  it('rejects an SSRF-prone url at save time', async () => {
    for (const url of [
      'http://127.0.0.1/x',
      'http://localhost/x',
      'https://10.0.0.1',
      'ftp://x/y',
    ]) {
      const res = await create({ kind: 'http', slug: 'ssrf', url, intervalMinutes: 5 });
      expect(res.statusCode, url).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_url');
    }
  });

  it('rejects a bad slug and 409s a duplicate slug', async () => {
    expect(
      (
        await create({
          kind: 'http',
          slug: 'Bad Slug',
          url: 'https://e.example',
          intervalMinutes: 5,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await create({ kind: 'http', slug: 'dup', url: 'https://e.example', intervalMinutes: 5 }))
        .statusCode,
    ).toBe(201);
    const again = await create({
      kind: 'http',
      slug: 'dup',
      url: 'https://e.example',
      intervalMinutes: 5,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toBe('slug_exists');
  });

  it('404s on an unknown project', async () => {
    const res = await create(
      { kind: 'http', slug: 'ops', url: 'https://e.example', intervalMinutes: 5 },
      'nope',
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/monitors/:id — kind immutability + http fields', () => {
  const createHttp = async (slug: string) => {
    const res = await app().inject({
      method: 'POST',
      url: `/api/projects/${project.id}/monitors`,
      headers: auth(),
      payload: { kind: 'http', slug, url: 'https://err.example/a', intervalMinutes: 5 },
    });
    return res.json<{ monitor: MonitorRowLike }>().monitor;
  };
  type MonitorRowLike = { id: string; kind: string };

  it('rejects changing kind', async () => {
    const m = await createHttp('ops');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { kind: 'checkin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('kind_immutable');
  });

  it('updates the url of an http monitor (re-validating SSRF)', async () => {
    const m = await createHttp('ops2');
    const good = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { url: 'https://err.example/b' },
    });
    expect(good.statusCode).toBe(200);
    expect(getMonitor(db, m.id)?.url).toBe('https://err.example/b');
    const bad = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { url: 'http://127.0.0.1' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects url on a check-in monitor', async () => {
    const m = seedMonitor('cron');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/monitors/${m.id}`,
      headers: auth(),
      payload: { url: 'https://err.example' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('url_not_applicable');
  });
});
