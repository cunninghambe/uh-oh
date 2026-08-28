import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject, updateProject } from '../db/repos/projects.js';
import {
  createMonitor,
  getMonitor,
  getMonitorBySlug,
  setMonitorStatus,
} from '../db/repos/monitors.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });

const checkIn = (
  server: ReturnType<typeof buildServer>,
  slug: string,
  publicKey = project.publicKey,
  query = '',
) => server.inject({ method: 'POST', url: `/ingest/${publicKey}/check-in/${slug}${query}` });

describe('POST /ingest/:publicKey/check-in/:slug', () => {
  it('rejects an unknown public key with 401', async () => {
    const res = await checkIn(app(), 'cron', 'pk_nope');
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid slug with 400', async () => {
    const res = await checkIn(app(), 'Bad_Slug', project.publicKey, '?intervalMinutes=10');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_slug');
  });

  it('409s a check-in ping against an http monitor (§24)', async () => {
    createMonitor(db, {
      projectId: project.id,
      slug: 'ops',
      intervalMinutes: 5,
      graceMinutes: 5,
      kind: 'http',
      url: 'https://err.example/health',
      now: Date.now(),
    });
    const res = await checkIn(app(), 'ops', project.publicKey, '?intervalMinutes=5');
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('not_a_checkin_monitor');
    // The http monitor is untouched — no check-in recorded.
    expect(getMonitorBySlug(db, project.id, 'ops')?.lastCheckInAt).toBeNull();
  });

  it('auto-creates on the first ping and requires intervalMinutes', async () => {
    const server = app();
    const missing = await checkIn(server, 'cron');
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: string }>().error).toBe('intervalMinutes_required');

    const created = await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    expect(created.statusCode).toBe(202);
    const { monitorId } = created.json<{ monitorId: string }>();
    const monitor = getMonitor(db, monitorId);
    expect(monitor?.slug).toBe('cron');
    expect(monitor?.intervalMinutes).toBe(10);
    expect(monitor?.graceMinutes).toBe(5); // default grace max(5, ceil(10/4))
    expect(monitor?.lastCheckInAt).toBeNull(); // first ping only creates
  });

  it('rejects an invalid intervalMinutes', async () => {
    const res = await checkIn(app(), 'cron', project.publicKey, '?intervalMinutes=0');
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_intervalMinutes');
  });

  it('later pings bump lastCheckInAt and can re-set the cadence', async () => {
    const server = app();
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    const before = getMonitorBySlug(db, project.id, 'cron');
    expect(before?.lastCheckInAt).toBeNull();

    const second = await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=20');
    expect(second.statusCode).toBe(202);
    const after = getMonitorBySlug(db, project.id, 'cron');
    expect(after?.lastCheckInAt).not.toBeNull();
    expect(after?.intervalMinutes).toBe(20);
  });

  it('recovers a missed monitor and enqueues monitor.recovered when a webhook is set', async () => {
    updateProject(db, project.id, { webhookUrl: 'https://hooks.example.com/uh-oh' });
    const server = app();
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    const monitor = getMonitorBySlug(db, project.id, 'cron');
    setMonitorStatus(db, monitor!.id, 'missed');

    const res = await checkIn(server, 'cron');
    expect(res.statusCode).toBe(202);
    expect(getMonitorBySlug(db, project.id, 'cron')?.status).toBe('ok');

    const due = takeDueDispatches(db, Date.now() + 1000, 10);
    const recovered = due.find((d) => d.type === 'monitor.recovered');
    expect(recovered).toBeDefined();
    expect(recovered?.monitorId).toBe(monitor!.id);
    expect(recovered?.issueId).toBeNull();
  });

  it('does not enqueue a recovery dispatch when the project has no webhook', async () => {
    const server = app();
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    const monitor = getMonitorBySlug(db, project.id, 'cron');
    setMonitorStatus(db, monitor!.id, 'missed');
    await checkIn(server, 'cron');
    const due = takeDueDispatches(db, Date.now() + 1000, 10);
    expect(due).toHaveLength(0);
  });

  it('recovers via the instance default webhook when the project has none', async () => {
    const server = buildServer({
      db,
      secret: TEST_SECRET,
      password: 'test-password',
      defaultWebhookUrl: 'https://hooks.example/instance',
    });
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    const monitor = getMonitorBySlug(db, project.id, 'cron');
    setMonitorStatus(db, monitor!.id, 'missed');

    await checkIn(server, 'cron');
    const recovered = takeDueDispatches(db, Date.now() + 1000, 10).find(
      (d) => d.type === 'monitor.recovered',
    );
    expect(recovered?.url).toBe('https://hooks.example/instance');
  });

  it('warns instead of silently dropping a recovery with nowhere to go', async () => {
    const server = app();
    const warn = vi.spyOn(server.log, 'warn');
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    const monitor = getMonitorBySlug(db, project.id, 'cron');
    setMonitorStatus(db, monitor!.id, 'missed');

    await checkIn(server, 'cron');
    expect(takeDueDispatches(db, Date.now() + 1000, 10)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('monitor.recovered');
    expect(msg).toContain('App');
    expect(msg).toContain('UH_OH_DEFAULT_WEBHOOK_URL');
    warn.mockRestore();
  });

  it('rate-limits excessive pings to one monitor', async () => {
    const server = app();
    await checkIn(server, 'cron', project.publicKey, '?intervalMinutes=10');
    let sawRateLimit = false;
    for (let i = 0; i < 40; i++) {
      const res = await checkIn(server, 'cron');
      if (res.statusCode === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
