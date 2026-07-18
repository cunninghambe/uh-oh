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
