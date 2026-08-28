import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject, updateProject } from '../db/repos/projects.js';
import { createMonitor, getMonitor, setMonitorStatus } from '../db/repos/monitors.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';
import { sweepMonitors, startMonitorSweep } from './sweep.js';

let db: Db;
let close: () => void;
let projectId: string;

const MIN = 60_000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const p = createProject(db, { name: 'App' });
  projectId = p.id;
  updateProject(db, projectId, { webhookUrl: 'https://hooks.example.com/uh-oh' });
});
afterEach(() => close());

const mk = (slug: string, interval = 10, grace = 5, createdAt = NOW) =>
  createMonitor(db, {
    projectId,
    slug,
    intervalMinutes: interval,
    graceMinutes: grace,
    now: createdAt,
  });

const counterValue = async (): Promise<number> => {
  const m = await metrics.monitorMissed.get();
  return m.values.reduce((s, v) => s + v.value, 0);
};

const monitorMissedDispatches = (now: number) =>
  takeDueDispatches(db, now, 100).filter((d) => d.type === 'monitor.missed');

describe('sweepMonitors', () => {
  it('flips overdue ok monitors to missed and dispatches monitor.missed once', async () => {
    const m = mk('cron'); // deadline NOW + 15min (never checked in)
    const before = await counterValue();

    const at = NOW + 20 * MIN;
    expect(sweepMonitors(db, at)).toBe(1);
    expect(getMonitor(db, m.id)?.status).toBe('missed');
    expect(await counterValue()).toBe(before + 1);

    const dispatches = monitorMissedDispatches(at + 1);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.monitorId).toBe(m.id);
    expect(dispatches[0]?.eventId).toBeNull();

    // The status transition is the dedupe: a second sweep does nothing.
    expect(sweepMonitors(db, at + MIN)).toBe(0);
    expect(monitorMissedDispatches(at + 2 * MIN)).toHaveLength(1);
  });

  it('leaves a monitor that is not yet overdue alone', () => {
    const m = mk('cron');
    expect(sweepMonitors(db, NOW + 10 * MIN)).toBe(0);
    expect(getMonitor(db, m.id)?.status).toBe('ok');
  });

  it('skips paused monitors even when overdue', () => {
    const m = mk('paused-cron');
    setMonitorStatus(db, m.id, 'paused');
    expect(sweepMonitors(db, NOW + 100 * MIN)).toBe(0);
    expect(getMonitor(db, m.id)?.status).toBe('paused');
  });

  it('transitions a monitor with no webhook but enqueues nothing', () => {
    const p2 = createProject(db, { name: 'NoHook' });
    const m = createMonitor(db, {
      projectId: p2.id,
      slug: 'cron',
      intervalMinutes: 10,
      graceMinutes: 5,
      now: NOW,
    });
    expect(sweepMonitors(db, NOW + 30 * MIN)).toBe(1);
    expect(getMonitor(db, m.id)?.status).toBe('missed');
    const dispatches = takeDueDispatches(db, NOW + 31 * MIN, 100).filter(
      (d) => d.monitorId === m.id,
    );
    expect(dispatches).toHaveLength(0);
  });
});

// The incident this guards: a 'missed' monitor on a project with no webhook_url
// produced no dispatch row and no log line, so nobody heard about it for days.
describe('sweepMonitors — instance-level fallback webhook', () => {
  const DEFAULT_HOOK = 'https://hooks.example.com/instance';

  const hookless = (slug: string) => {
    const p = createProject(db, { name: 'NoHook' });
    return createMonitor(db, {
      projectId: p.id,
      slug,
      intervalMinutes: 10,
      graceMinutes: 5,
      now: NOW,
    });
  };

  it('dispatches to the default webhook when the project has none', () => {
    const m = hookless('cron');
    expect(sweepMonitors(db, NOW + 30 * MIN, { defaultWebhookUrl: DEFAULT_HOOK })).toBe(1);

    const dispatches = takeDueDispatches(db, NOW + 31 * MIN, 100).filter(
      (d) => d.monitorId === m.id,
    );
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.url).toBe(DEFAULT_HOOK);
    expect(dispatches[0]?.type).toBe('monitor.missed');
  });

  it("keeps using the project's own webhook when it has one", () => {
    const m = mk('cron'); // project webhook set in beforeEach
    expect(sweepMonitors(db, NOW + 30 * MIN, { defaultWebhookUrl: DEFAULT_HOOK })).toBe(1);

    const dispatches = takeDueDispatches(db, NOW + 31 * MIN, 100).filter(
      (d) => d.monitorId === m.id,
    );
    expect(dispatches[0]?.url).toBe('https://hooks.example.com/uh-oh');
  });

  it('warns (never silently drops) when there is nowhere to send the miss', () => {
    const warn = vi.fn();
    const logger = { error: vi.fn(), warn };
    const m = hookless('cron');

    expect(sweepMonitors(db, NOW + 30 * MIN, { logger })).toBe(1);
    expect(getMonitor(db, m.id)?.status).toBe('missed');
    expect(takeDueDispatches(db, NOW + 31 * MIN, 100).filter((d) => d.monitorId === m.id)).toEqual(
      [],
    );

    expect(warn).toHaveBeenCalledOnce();
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('monitor.missed');
    expect(msg).toContain('NoHook');
    expect(msg).toContain('UH_OH_DEFAULT_WEBHOOK_URL');
  });

  it('does not warn when the fallback covers the project', () => {
    const warn = vi.fn();
    hookless('cron');
    sweepMonitors(db, NOW + 30 * MIN, {
      logger: { error: vi.fn(), warn },
      defaultWebhookUrl: DEFAULT_HOOK,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('startMonitorSweep', () => {
  it('runs a sweep via sweepOnce and stops cleanly', () => {
    const m = mk('cron');
    const handle = startMonitorSweep({ db, intervalMs: 1_000_000 });
    try {
      expect(handle.sweepOnce(NOW + 30 * MIN)).toBe(1);
      expect(getMonitor(db, m.id)?.status).toBe('missed');
    } finally {
      handle.stop();
    }
  });

  it('threads the default webhook through sweepOnce', () => {
    const p = createProject(db, { name: 'NoHook' });
    const m = createMonitor(db, {
      projectId: p.id,
      slug: 'cron',
      intervalMinutes: 10,
      graceMinutes: 5,
      now: NOW,
    });
    const handle = startMonitorSweep({
      db,
      intervalMs: 1_000_000,
      defaultWebhookUrl: 'https://hooks.example.com/instance',
    });
    try {
      expect(handle.sweepOnce(NOW + 30 * MIN)).toBe(1);
      const dispatches = takeDueDispatches(db, NOW + 31 * MIN, 100).filter(
        (d) => d.monitorId === m.id,
      );
      expect(dispatches[0]?.url).toBe('https://hooks.example.com/instance');
    } finally {
      handle.stop();
    }
  });
});
