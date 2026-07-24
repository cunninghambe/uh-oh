import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { applyProbeOutcome, createMonitor } from '../db/repos/monitors.js';
import { enqueueDispatch, takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { startDispatcher as startDispatcherRaw, type DnsLookupAll } from './dispatcher.js';

const NOW = 1_000_000;
const WEBHOOK_URL = 'https://hooks.example/monitors';
const publicLookup: DnsLookupAll = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
const startDispatcher: typeof startDispatcherRaw = (deps) =>
  startDispatcherRaw({ lookupFn: publicLookup, ...deps });

let db: Db;
let close: () => void;
let projectId: string;
let monitorId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const project = createProject(db, { name: 'Fleet', webhookUrl: WEBHOOK_URL });
  projectId = project.id;
  monitorId = createMonitor(db, {
    projectId,
    slug: 'nightly-backup',
    name: 'Nightly Backup',
    intervalMinutes: 60,
    graceMinutes: 15,
    now: NOW,
  }).id;
});

afterEach(() => close());

const runOnce = async (dashboardUrl?: string): Promise<{ url: string; body: unknown }[]> => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = vi.fn((url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    return Promise.resolve({ ok: true, status: 200 } as Response);
  });
  const handle = startDispatcher({
    db,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => NOW,
    pollIntervalMs: 10,
    ...(dashboardUrl !== undefined ? { dashboardUrl } : {}),
  });
  await new Promise<void>((r) => setTimeout(r, 80));
  await handle.stop();
  return calls;
};

describe('dispatcher — monitor payloads', () => {
  it('builds a monitor.missed payload with project + monitor and no issue/event fields', async () => {
    enqueueDispatch(db, { monitorId, url: WEBHOOK_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce('https://dash.example');
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      type: 'monitor.missed',
      project: { slug: 'fleet' },
      monitor: {
        id: monitorId,
        slug: 'nightly-backup',
        name: 'Nightly Backup',
        intervalMinutes: 60,
        graceMinutes: 15,
        lastCheckInAt: null,
      },
      url: `https://dash.example/monitors/${monitorId}`,
    });
    expect(body).not.toHaveProperty('issue');
    expect(body).not.toHaveProperty('event');
    // Row is done.
    expect(takeDueDispatches(db, NOW + 1e9, 10)).toHaveLength(0);
  });

  it('builds a monitor.recovered payload and omits url when no dashboard is configured', async () => {
    enqueueDispatch(db, { monitorId, url: WEBHOOK_URL, type: 'monitor.recovered' }, NOW);
    const calls = await runOnce();
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['type']).toBe('monitor.recovered');
    expect(body).not.toHaveProperty('url');
  });

  it('omits the probe field for a check-in monitor (byte-identical v0.8 payload)', async () => {
    enqueueDispatch(db, { monitorId, url: WEBHOOK_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce();
    expect(calls[0]?.body).not.toHaveProperty('probe');
  });
});

describe('dispatcher — http monitor probe payloads (§24)', () => {
  const mkHttp = (slug: string) =>
    createMonitor(db, {
      projectId,
      slug,
      intervalMinutes: 5,
      graceMinutes: 5,
      kind: 'http',
      url: 'https://svc.example/health',
      timeoutMs: 5000,
      now: NOW,
    }).id;

  it('carries probe.status when the last probe returned an HTTP status', async () => {
    const id = mkHttp('ops');
    applyProbeOutcome(db, id, { ok: false, status: 502 }, NOW);
    enqueueDispatch(db, { monitorId: id, url: WEBHOOK_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce();
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['probe']).toEqual({ status: 502 });
  });

  it('carries a probe.error when the last probe got no HTTP response', async () => {
    const id = mkHttp('rebind');
    applyProbeOutcome(db, id, { ok: false, status: null }, NOW);
    enqueueDispatch(db, { monitorId: id, url: WEBHOOK_URL, type: 'monitor.missed' }, NOW);
    const calls = await runOnce();
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body['probe']).toEqual({ error: 'probe_failed' });
  });
});
