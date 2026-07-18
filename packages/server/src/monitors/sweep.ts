// CONTRACT M — the dead-man's-switch sweep. A 60s in-process job flips every
// overdue, non-paused monitor from 'ok' to 'missed' and dispatches a
// `monitor.missed` webhook ONCE per miss episode (the status transition is the
// dedupe — a monitor already 'missed' is skipped until a check-in recovers it).

import type { Db } from '../db/index.js';
import { isOverdue, listOkMonitors, setMonitorStatus } from '../db/repos/monitors.js';
import { getProjectById } from '../db/repos/projects.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';

export type SweepLogger = {
  error: (msg: string, meta?: object) => void;
  info?: (msg: string, meta?: object) => void;
};

export type MonitorSweepDeps = {
  db: Db;
  now?: () => number;
  /** Sweep cadence (default 60s). */
  intervalMs?: number;
  logger?: SweepLogger;
};

export type MonitorSweepHandle = {
  stop: () => void;
  /** Run one sweep synchronously (used by tests + the scheduled tick). */
  sweepOnce: (now?: number) => number;
};

/**
 * Transition every overdue 'ok' monitor to 'missed', enqueueing a monitor.missed
 * dispatch per project webhook. Each transition is its own transaction so one
 * bad row can't abort the whole sweep. Returns the number of new misses.
 */
export const sweepMonitors = (db: Db, now: number, logger?: SweepLogger): number => {
  let missed = 0;
  for (const m of listOkMonitors(db)) {
    if (!isOverdue(m, now)) continue;
    try {
      db.transaction((tx) => {
        setMonitorStatus(tx, m.id, 'missed');
        const project = getProjectById(tx, m.projectId);
        if (project?.webhookUrl) {
          enqueueDispatch(
            tx,
            { monitorId: m.id, url: project.webhookUrl, type: 'monitor.missed' },
            now,
          );
        }
      });
      // Count only after the transaction commits (mirrors ingest's metric timing).
      metrics.monitorMissed.inc();
      missed++;
    } catch (err) {
      logger?.error('monitor sweep transition failed', {
        id: m.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return missed;
};

export const startMonitorSweep = (deps: MonitorSweepDeps): MonitorSweepHandle => {
  const intervalMs = deps.intervalMs ?? 60_000;
  const nowFn = deps.now ?? (() => Date.now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = (): void => {
    if (stopped) return;
    try {
      sweepMonitors(deps.db, nowFn(), deps.logger);
    } catch (err) {
      // The sweep must never silently die; log and keep scheduling.
      deps.logger?.error('monitor sweep iteration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
        timer.unref?.();
      }
    }
  };

  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    sweepOnce: (now?: number) => sweepMonitors(deps.db, now ?? nowFn(), deps.logger),
  };
};
