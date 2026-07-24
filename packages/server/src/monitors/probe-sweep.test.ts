// §24 — the http-probe pass of the monitor sweep, with an injected clock,
// stubbed fetch, and injected DNS resolver. Covers the two-consecutive-failure
// miss episode (dispatched once), first-success recovery (dispatched once), the
// per-tick probe cap, probe-time SSRF rejection, and the failure metric.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { createMonitor, getMonitor } from '../db/repos/monitors.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import type { DnsLookupAll } from '../webhooks/dispatcher.js';
import { metrics } from '../metrics/registry.js';
import { sweepHttpProbes } from './sweep.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const WEBHOOK = 'https://hooks.example/uptime';

const publicLookup: DnsLookupAll = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
const privateLookup: DnsLookupAll = () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]);

let db: Db;
let close: () => void;
let projectId: string;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  projectId = createProject(db, { name: 'App', webhookUrl: WEBHOOK }).id;
});
afterEach(() => close());

const mkHttp = (slug: string, url = 'https://svc.example/health') =>
  createMonitor(db, {
    projectId,
    slug,
    intervalMinutes: 1,
    graceMinutes: 5,
    kind: 'http',
    url,
    timeoutMs: 5000,
    now: NOW,
  });

const dispatchesOfType = (type: string, monitorId: string) =>
  takeDueDispatches(db, NOW + 1e12, 1000).filter(
    (d) => d.type === type && d.monitorId === monitorId,
  );

describe('sweepHttpProbes — miss/recover episode with injected clock + fetch', () => {
  it('flips missed only on the second consecutive failure and recovers on the first success', async () => {
    const m = mkHttp('ops');
    let status = 500;
    const fetchFn = vi.fn(() => Promise.resolve({ status } as Response)) as unknown as typeof fetch;
    const deps = { fetchFn, lookupFn: publicLookup };

    // Failure #1 — still ok, no webhook.
    await sweepHttpProbes(db, NOW, deps);
    expect(getMonitor(db, m.id)).toMatchObject({
      status: 'ok',
      consecutiveFailures: 1,
      lastProbeAt: NOW,
      lastProbeStatus: 500,
    });
    expect(dispatchesOfType('monitor.missed', m.id)).toHaveLength(0);

    // Failure #2 (next interval) — flips to missed, dispatches once.
    await sweepHttpProbes(db, NOW + 1 * MIN, deps);
    expect(getMonitor(db, m.id)).toMatchObject({ status: 'missed', consecutiveFailures: 2 });
    expect(dispatchesOfType('monitor.missed', m.id)).toHaveLength(1);

    // Failure #3 — already missed: streak grows but NO second webhook.
    await sweepHttpProbes(db, NOW + 2 * MIN, deps);
    expect(getMonitor(db, m.id)).toMatchObject({ status: 'missed', consecutiveFailures: 3 });
    expect(dispatchesOfType('monitor.missed', m.id)).toHaveLength(1);

    // First success — recovers, dispatches monitor.recovered exactly once.
    status = 200;
    await sweepHttpProbes(db, NOW + 3 * MIN, deps);
    expect(getMonitor(db, m.id)).toMatchObject({
      status: 'ok',
      consecutiveFailures: 0,
      lastProbeStatus: 200,
    });
    expect(dispatchesOfType('monitor.recovered', m.id)).toHaveLength(1);
    // Still exactly one missed across the whole episode.
    expect(dispatchesOfType('monitor.missed', m.id)).toHaveLength(1);
  });

  it('does not probe a monitor before its interval elapses', async () => {
    const m = mkHttp('ops');
    const fetchFn = vi.fn(() =>
      Promise.resolve({ status: 200 } as Response),
    ) as unknown as typeof fetch;
    await sweepHttpProbes(db, NOW, { fetchFn, lookupFn: publicLookup });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // 30s later — not yet due (interval is 60s).
    await sweepHttpProbes(db, NOW + 30_000, { fetchFn, lookupFn: publicLookup });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // 60s after the last probe — due again.
    await sweepHttpProbes(db, NOW + 1 * MIN, { fetchFn, lookupFn: publicLookup });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(getMonitor(db, m.id)?.lastProbeAt).toBe(NOW + 1 * MIN);
  });
});

describe('sweepHttpProbes — cap, SSRF, and metric', () => {
  it('probes at most 5 monitors per tick, picking up the rest next tick', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => mkHttp(`svc-${String(i)}`).id);
    const fetchFn = vi.fn(() =>
      Promise.resolve({ status: 200 } as Response),
    ) as unknown as typeof fetch;
    const deps = { fetchFn, lookupFn: publicLookup };

    await sweepHttpProbes(db, NOW, deps);
    const probed = () => ids.filter((id) => getMonitor(db, id)?.lastProbeAt !== null).length;
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(probed()).toBe(5);

    // Same instant: the 5 just probed are not due again, but the remaining 2 are.
    await sweepHttpProbes(db, NOW, deps);
    expect(fetchFn).toHaveBeenCalledTimes(7);
    expect(probed()).toBe(7);
  });

  it('fails a probe whose host resolves to a blocked address (SSRF at probe time)', async () => {
    const m = mkHttp('rebind', 'https://evil.example/health');
    const fetchFn = vi.fn(() =>
      Promise.resolve({ status: 200 } as Response),
    ) as unknown as typeof fetch;
    await sweepHttpProbes(db, NOW, { fetchFn, lookupFn: privateLookup });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getMonitor(db, m.id)).toMatchObject({
      consecutiveFailures: 1,
      lastProbeStatus: null,
      lastProbeAt: NOW,
    });
  });

  it('increments uh_oh_uptime_probe_failures_total once per failed probe', async () => {
    mkHttp('a');
    mkHttp('b');
    const total = async () => {
      const v = (await metrics.uptimeProbeFailures.get()).values;
      return v.reduce((s, x) => s + x.value, 0);
    };
    const before = await total();
    const fetchFn = vi.fn(() =>
      Promise.resolve({ status: 503 } as Response),
    ) as unknown as typeof fetch;
    await sweepHttpProbes(db, NOW, { fetchFn, lookupFn: publicLookup });
    expect((await total()) - before).toBe(2);
  });
});
