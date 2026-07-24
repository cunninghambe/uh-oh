// CONTRACT M — check-in monitors (dead-man's-switch). Repo layer: CRUD, the
// check-in upsert, the sweep's overdue detection, and the computed-`overdue`
// listing shared by the API route and the MCP list_monitors tool.

import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';

import type { Monitor } from '@uh-oh/mcp';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { monitors, projects, type MonitorRow } from '../schema.js';

export type MonitorStatus = 'ok' | 'missed' | 'paused';
export type MonitorKind = 'checkin' | 'http';

/** Default per-probe timeout (ms) for an http monitor, and the hard cap. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const MAX_PROBE_TIMEOUT_MS = 30_000;

/** Max http probes started per sweep tick; the remainder waits for the next tick. */
export const MAX_PROBES_PER_TICK = 5;

/** Consecutive failed probes that flip an http monitor ok -> missed. */
export const PROBE_FAILURE_THRESHOLD = 2;

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
    // v0.9: an http monitor carries kind:'http', a url, and an optional timeout.
    // A check-in monitor (the default) leaves these null.
    kind?: MonitorKind;
    url?: string | null;
    timeoutMs?: number | null;
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
    kind: input.kind ?? 'checkin',
    url: input.url ?? null,
    timeoutMs: input.timeoutMs ?? null,
    lastProbeAt: null,
    lastProbeStatus: null,
    consecutiveFailures: 0,
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

/**
 * Non-paused CHECK-IN monitors currently in 'ok' — the dead-man's-switch sweep's
 * candidate set. http monitors are excluded: they are driven by active probes,
 * not check-in deadlines, so the overdue sweep must never touch them.
 */
export const listOkMonitors = (db: DbOrTx): MonitorRow[] =>
  db
    .select()
    .from(monitors)
    .where(and(eq(monitors.status, 'ok'), eq(monitors.kind, 'checkin')))
    .all();

export const updateMonitor = (
  db: DbOrTx,
  id: string,
  patch: Partial<
    Pick<MonitorRow, 'name' | 'intervalMinutes' | 'graceMinutes' | 'status' | 'url' | 'timeoutMs'>
  >,
): MonitorRow | null => {
  const existing = getMonitor(db, id);
  if (!existing) return null;
  if (Object.keys(patch).length > 0) {
    db.update(monitors).set(patch).where(eq(monitors.id, id)).run();
  }
  return getMonitor(db, id);
};

/**
 * http monitors due for a probe at `now`: never-probed rows first, then those
 * whose last probe is older than their interval, capped at `limit` per tick.
 * Paused monitors are skipped; a 'missed' monitor keeps being probed so it can
 * recover. NULL last_probe_at sorts first under SQLite ASC ordering.
 */
export const listDueHttpProbes = (db: DbOrTx, now: number, limit: number): MonitorRow[] =>
  db
    .select()
    .from(monitors)
    .where(
      and(
        eq(monitors.kind, 'http'),
        ne(monitors.status, 'paused'),
        or(
          isNull(monitors.lastProbeAt),
          sql`${monitors.lastProbeAt} + ${monitors.intervalMinutes} * 60000 <= ${now}`,
        ),
      ),
    )
    .orderBy(asc(monitors.lastProbeAt), asc(monitors.id))
    .limit(limit)
    .all();

export type ProbeOutcome = { ok: boolean; status: number | null };

/**
 * Record one probe result on an http monitor and report any status transition.
 * A success resets the failure streak and recovers a 'missed' monitor on the
 * first success; a failure grows the streak and flips ok -> missed once it
 * reaches {@link PROBE_FAILURE_THRESHOLD}. The status transition is the dedupe,
 * so a webhook fires exactly once per episode (like check-in monitors).
 */
export const applyProbeOutcome = (
  db: DbOrTx,
  monitorId: string,
  outcome: ProbeOutcome,
  now: number,
): { transition: 'missed' | 'recovered' | null } => {
  const m = getMonitor(db, monitorId);
  if (!m) return { transition: null };

  if (outcome.ok) {
    const patch: Partial<MonitorRow> = {
      lastProbeAt: now,
      lastProbeStatus: outcome.status,
      consecutiveFailures: 0,
    };
    const recovered = m.status === 'missed';
    if (recovered) patch.status = 'ok';
    db.update(monitors).set(patch).where(eq(monitors.id, monitorId)).run();
    return { transition: recovered ? 'recovered' : null };
  }

  const consecutiveFailures = m.consecutiveFailures + 1;
  const patch: Partial<MonitorRow> = {
    lastProbeAt: now,
    lastProbeStatus: outcome.status,
    consecutiveFailures,
  };
  const missed = consecutiveFailures >= PROBE_FAILURE_THRESHOLD && m.status === 'ok';
  if (missed) patch.status = 'missed';
  db.update(monitors).set(patch).where(eq(monitors.id, monitorId)).run();
  return { transition: missed ? 'missed' : null };
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
 * A monitor with its computed `overdue` flag, plus the v0.9 http fields. This
 * widens the MCP `Monitor` shape with `kind`/`url`/`lastProbeStatus` (and the
 * probe bookkeeping) so the API list route can surface them; the extra fields
 * are structurally compatible with `Monitor` (the MCP tool reads the subset it
 * knows). `overdue` is meaningful only for check-in monitors — http health is
 * carried by `status`, so http rows always report `overdue: false`.
 */
export type MonitorWithComputed = Monitor & {
  kind: MonitorKind;
  url: string | null;
  timeoutMs: number | null;
  lastProbeAt: number | null;
  lastProbeStatus: number | null;
  consecutiveFailures: number;
};

/**
 * Monitors with a computed `overdue` flag and their project slug, for the API
 * list route and the MCP list_monitors tool. `projectId` filters to one project.
 */
export const listMonitorsWithComputed = (
  db: DbOrTx,
  input: { projectId?: string; now?: number },
): MonitorWithComputed[] => {
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
    overdue: m.kind === 'checkin' && isOverdue(m, now),
    kind: m.kind,
    url: m.url,
    timeoutMs: m.timeoutMs,
    lastProbeAt: m.lastProbeAt,
    lastProbeStatus: m.lastProbeStatus,
    consecutiveFailures: m.consecutiveFailures,
  }));
};
