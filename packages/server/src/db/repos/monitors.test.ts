import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import {
  createMonitor,
  defaultGraceMinutes,
  deleteMonitor,
  getMonitor,
  getMonitorBySlug,
  isOverdue,
  listMonitorsForProject,
  listMonitorsWithComputed,
  listOkMonitors,
  recordCheckIn,
  setMonitorStatus,
  updateMonitor,
  MONITOR_SLUG_RE,
} from './monitors.js';

let db: Db;
let close: () => void;
let projectId: string;
let projectSlug: string;

const MIN = 60_000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  const p = createProject(db, { name: 'App' });
  projectId = p.id;
  projectSlug = p.slug;
});
afterEach(() => close());

const mk = (slug: string, interval = 10, grace = 5, now = NOW) =>
  createMonitor(db, { projectId, slug, intervalMinutes: interval, graceMinutes: grace, now });

describe('monitor slug + grace helpers', () => {
  it('accepts valid slugs and rejects invalid ones', () => {
    expect(MONITOR_SLUG_RE.test('nightly-backup')).toBe(true);
    expect(MONITOR_SLUG_RE.test('a')).toBe(true);
    expect(MONITOR_SLUG_RE.test('Bad_Slug')).toBe(false);
    expect(MONITOR_SLUG_RE.test('has space')).toBe(false);
    expect(MONITOR_SLUG_RE.test('')).toBe(false);
    expect(MONITOR_SLUG_RE.test('x'.repeat(65))).toBe(false);
  });

  it('defaults grace to max(5, ceil(interval/4))', () => {
    expect(defaultGraceMinutes(10)).toBe(5); // ceil(2.5)=3 -> min 5
    expect(defaultGraceMinutes(60)).toBe(15);
    expect(defaultGraceMinutes(1)).toBe(5);
    expect(defaultGraceMinutes(40)).toBe(10);
  });
});

describe('monitor CRUD repo', () => {
  it('creates, fetches by id + slug, and enforces per-project slug uniqueness', () => {
    const m = mk('cron');
    expect(getMonitor(db, m.id)?.slug).toBe('cron');
    expect(getMonitorBySlug(db, projectId, 'cron')?.id).toBe(m.id);
    expect(getMonitorBySlug(db, projectId, 'nope')).toBeNull();
    // Same slug under a different project is allowed.
    const p2 = createProject(db, { name: 'Other' });
    expect(() =>
      createMonitor(db, {
        projectId: p2.id,
        slug: 'cron',
        intervalMinutes: 5,
        graceMinutes: 5,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it('updates fields and deletes', () => {
    const m = mk('cron');
    updateMonitor(db, m.id, { name: 'Nightly', intervalMinutes: 30, status: 'paused' });
    const updated = getMonitor(db, m.id);
    expect(updated?.name).toBe('Nightly');
    expect(updated?.intervalMinutes).toBe(30);
    expect(updated?.status).toBe('paused');
    expect(deleteMonitor(db, m.id)).toBe(true);
    expect(getMonitor(db, m.id)).toBeNull();
    expect(deleteMonitor(db, m.id)).toBe(false);
  });

  it('lists monitors for a project in creation order', () => {
    mk('a', 10, 5, NOW);
    mk('b', 10, 5, NOW + 1);
    expect(listMonitorsForProject(db, projectId).map((m) => m.slug)).toEqual(['a', 'b']);
  });
});

describe('isOverdue', () => {
  it('uses lastCheckInAt when present, else createdAt', () => {
    const m = mk('cron', 10, 5); // deadline = base + 15min
    expect(isOverdue(m, NOW + 14 * MIN)).toBe(false);
    expect(isOverdue(m, NOW + 16 * MIN)).toBe(true);
    const checked = { ...m, lastCheckInAt: NOW + 100 * MIN };
    expect(isOverdue(checked, NOW + 110 * MIN)).toBe(false);
    expect(isOverdue(checked, NOW + 116 * MIN)).toBe(true);
  });
});

describe('recordCheckIn', () => {
  it('bumps lastCheckInAt and optionally updates the interval', () => {
    const m = mk('cron', 10, 5);
    const r = recordCheckIn(db, m.id, { now: NOW + 5 * MIN, intervalMinutes: 20 });
    expect(r?.monitor.lastCheckInAt).toBe(NOW + 5 * MIN);
    expect(r?.monitor.intervalMinutes).toBe(20);
    expect(r?.recovered).toBe(false);
  });

  it('recovers a missed monitor back to ok and reports the transition', () => {
    const m = mk('cron', 10, 5);
    setMonitorStatus(db, m.id, 'missed');
    const r = recordCheckIn(db, m.id, { now: NOW + 100 * MIN });
    expect(r?.recovered).toBe(true);
    expect(r?.monitor.status).toBe('ok');
  });

  it('leaves a paused monitor paused (no false recovery)', () => {
    const m = mk('cron', 10, 5);
    setMonitorStatus(db, m.id, 'paused');
    const r = recordCheckIn(db, m.id, { now: NOW + 100 * MIN });
    expect(r?.recovered).toBe(false);
    expect(r?.monitor.status).toBe('paused');
  });
});

describe('listOkMonitors + listMonitorsWithComputed', () => {
  it('listOkMonitors returns only ok monitors', () => {
    mk('ok1');
    const m2 = mk('missed1');
    setMonitorStatus(db, m2.id, 'missed');
    const m3 = mk('paused1');
    setMonitorStatus(db, m3.id, 'paused');
    expect(listOkMonitors(db).map((m) => m.slug)).toEqual(['ok1']);
  });

  it('adds projectSlug + computed overdue, filterable by project', () => {
    const m = mk('cron', 10, 5);
    const rows = listMonitorsWithComputed(db, { projectId, now: NOW + 100 * MIN });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: m.id, projectSlug, slug: 'cron', overdue: true });
    // A different project id yields nothing.
    const other = createProject(db, { name: 'Other' });
    expect(listMonitorsWithComputed(db, { projectId: other.id })).toEqual([]);
    // No filter returns all.
    expect(listMonitorsWithComputed(db, { now: NOW })).toHaveLength(1);
  });
});
