// CONTRACT M — check-in monitors (dead-man's-switch). Repo layer: CRUD, the
// check-in upsert, the sweep's overdue detection, and the computed-`overdue`
// listing shared by the API route and the MCP list_monitors tool.

import { and, asc, eq } from 'drizzle-orm';

import type { Monitor } from '@uh-oh/mcp';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { monitors, projects, type MonitorRow } from '../schema.js';

export type MonitorStatus = 'ok' | 'missed' | 'paused';

/** Monitor slug shape: lowercase alnum + dashes, 1..64 chars. */
export const MONITOR_SLUG_RE = /^[a-z0-9-]{1,64}$/;

const MINUTE_MS = 60_000;

/** Default grace when a monitor is auto-created: quarter the interval, min 5. */
export const defaultGraceMinutes = (intervalMinutes: number): number =>
  Math.max(5, Math.ceil(intervalMinutes / 4));

/** Deadline (epoch ms) after which a monitor counts as overdue. */
const overdueDeadline = (
  m: Pick<MonitorRow, 'lastCheckInAt' | 'createdAt' | 'intervalMinutes' | 'graceMinutes'>,
): number => {
  const base = m.lastCheckInAt ?? m.createdAt;
  return base + (m.intervalMinutes + m.graceMinutes) * MINUTE_MS;
};

/** Is the monitor past its check-in deadline at `now` (pure time check)? */
export const isOverdue = (m: MonitorRow, now: number): boolean => now > overdueDeadline(m);

export const createMonitor = (
  db: DbOrTx,
  input: {
    projectId: string;
    slug: string;
    name?: string | null;
    intervalMinutes: number;
    graceMinutes: number;
    now: number;
  },
): MonitorRow => {
  const row: MonitorRow = {
    id: newId(),
    projectId: input.projectId,
    slug: input.slug,
    name: input.name ?? null,
    intervalMinutes: input.intervalMinutes,
    graceMinutes: input.graceMinutes,
    status: 'ok',
    lastCheckInAt: null,
    createdAt: input.now,
  };
  db.insert(monitors).values(row).run();
  return row;
};

export const getMonitor = (db: DbOrTx, id: string): MonitorRow | null =>
  db.select().from(monitors).where(eq(monitors.id, id)).get() ?? null;

export const getMonitorBySlug = (db: DbOrTx, projectId: string, slug: string): MonitorRow | null =>
  db
    .select()
    .from(monitors)
    .where(and(eq(monitors.projectId, projectId), eq(monitors.slug, slug)))
    .get() ?? null;

export const listMonitorsForProject = (db: DbOrTx, projectId: string): MonitorRow[] =>
  db
    .select()
    .from(monitors)
    .where(eq(monitors.projectId, projectId))
    .orderBy(asc(monitors.createdAt), asc(monitors.slug))
    .all();

/** Non-paused monitors currently in 'ok' — the sweep's candidate set. */
export const listOkMonitors = (db: DbOrTx): MonitorRow[] =>
  db.select().from(monitors).where(eq(monitors.status, 'ok')).all();

export const updateMonitor = (
  db: DbOrTx,
  id: string,
  patch: Partial<Pick<MonitorRow, 'name' | 'intervalMinutes' | 'graceMinutes' | 'status'>>,
): MonitorRow | null => {
  const existing = getMonitor(db, id);
  if (!existing) return null;
  if (Object.keys(patch).length > 0) {
    db.update(monitors).set(patch).where(eq(monitors.id, id)).run();
  }
  return getMonitor(db, id);
};

export const setMonitorStatus = (db: DbOrTx, id: string, status: MonitorStatus): void => {
  db.update(monitors).set({ status }).where(eq(monitors.id, id)).run();
};

export const deleteMonitor = (db: DbOrTx, id: string): boolean =>
  db.delete(monitors).where(eq(monitors.id, id)).run().changes > 0;

/**
 * Record a check-in: bump lastCheckInAt, optionally update the cadence when
 * `intervalMinutes` is supplied, and clear a 'missed' status back to 'ok'.
 * Returns the row and whether it recovered from 'missed' (so the caller can fire
 * the monitor.recovered webhook exactly on that transition).
 */
export const recordCheckIn = (
  db: DbOrTx,
  id: string,
  input: { now: number; intervalMinutes?: number },
): { monitor: MonitorRow; recovered: boolean } | null => {
  const existing = getMonitor(db, id);
  if (!existing) return null;
  const recovered = existing.status === 'missed';
  const set: Partial<MonitorRow> = { lastCheckInAt: input.now };
  if (input.intervalMinutes !== undefined) set.intervalMinutes = input.intervalMinutes;
  // A paused monitor stays paused (opt-out); only 'missed' recovers to 'ok'.
  if (existing.status === 'missed') set.status = 'ok';
  db.update(monitors).set(set).where(eq(monitors.id, id)).run();
  const monitor = getMonitor(db, id);
  return monitor ? { monitor, recovered } : null;
};

/**
 * Monitors with a computed `overdue` flag and their project slug, for the API
 * list route and the MCP list_monitors tool. `projectId` filters to one project.
 */
export const listMonitorsWithComputed = (
  db: DbOrTx,
  input: { projectId?: string; now?: number },
): Monitor[] => {
  const now = input.now ?? Date.now();
  const base = db
    .select({ m: monitors, projectSlug: projects.slug })
    .from(monitors)
    .innerJoin(projects, eq(projects.id, monitors.projectId))
    .orderBy(asc(monitors.createdAt), asc(monitors.slug));
  const rows = input.projectId
    ? base.where(eq(monitors.projectId, input.projectId)).all()
    : base.all();
  return rows.map(({ m, projectSlug }) => ({
    id: m.id,
    projectId: m.projectId,
    projectSlug,
    slug: m.slug,
    name: m.name,
    intervalMinutes: m.intervalMinutes,
    graceMinutes: m.graceMinutes,
    status: m.status,
    lastCheckInAt: m.lastCheckInAt,
    createdAt: m.createdAt,
    overdue: isOverdue(m, now),
  }));
};
