// CONTRACT M — the dead-man's-switch sweep. A 60s in-process job flips every
// overdue, non-paused monitor from 'ok' to 'missed' and dispatches a
// `monitor.missed` webhook ONCE per miss episode (the status transition is the
// dedupe — a monitor already 'missed' is skipped until a check-in recovers it).
//
// v0.9 §24: the same tick also PROBES http monitors due for a check. A probe is
// the inverse of a check-in — the server GETs the target URL and two consecutive
// failures flip the monitor 'missed' (dispatching monitor.missed once), the first
// success recovers it (monitor.recovered). Probes are network I/O, so they run
// asynchronously alongside the synchronous check-in sweep, capped per tick.

import { lookup as dnsLookup } from 'node:dns/promises';

import type { Db } from '../db/index.js';
import {
  applyProbeOutcome,
  isOverdue,
  listDueHttpProbes,
  listOkMonitors,
  setMonitorStatus,
  MAX_PROBES_PER_TICK,
} from '../db/repos/monitors.js';
import { getProjectById } from '../db/repos/projects.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import type { DnsLookupAll } from '../webhooks/dispatcher.js';
import { metrics } from '../metrics/registry.js';
import { probeHttpMonitor } from './probe.js';

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
  /** fetch used for http probes; injectable for tests (default global fetch). */
  fetchFn?: typeof fetch;
  /** DNS resolver for the probe-time SSRF re-check; injectable for tests. */
  lookupFn?: DnsLookupAll;
};

export type MonitorSweepHandle = {
  stop: () => void;
  /** Run one check-in sweep synchronously (used by tests + the scheduled tick). */
  sweepOnce: (now?: number) => number;
  /** Run one http-probe pass (used by tests + the scheduled tick). */
  probeOnce: (now?: number) => Promise<number>;
};

const defaultLookup: DnsLookupAll = (hostname) => dnsLookup(hostname, { all: true });

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

export type HttpProbeSweepDeps = {
  fetchFn: typeof fetch;
  lookupFn: DnsLookupAll;
  logger?: SweepLogger;
};

/**
 * Probe every http monitor due at `now` (capped at {@link MAX_PROBES_PER_TICK};
 * the remainder is picked up next tick). Each probe result is applied in its own
 * transaction: the failure streak / status is updated, and on a status
 * transition a monitor.missed / monitor.recovered dispatch is enqueued (exactly
 * once per episode). Each failed probe increments the failure metric. One bad row
 * can't abort the others. Returns the number of failed probes this pass.
 */
export const sweepHttpProbes = async (
  db: Db,
  now: number,
  deps: HttpProbeSweepDeps,
): Promise<number> => {
  const due = listDueHttpProbes(db, now, MAX_PROBES_PER_TICK);
  let failures = 0;
  await Promise.all(
    due.map(async (m) => {
      const result = await probeHttpMonitor(m, { fetchFn: deps.fetchFn, lookupFn: deps.lookupFn });
      try {
        db.transaction((tx) => {
          const { transition } = applyProbeOutcome(
            tx,
            m.id,
            { ok: result.ok, status: result.status },
            now,
          );
          if (transition) {
            const project = getProjectById(tx, m.projectId);
            if (project?.webhookUrl) {
              enqueueDispatch(
                tx,
                {
                  monitorId: m.id,
                  url: project.webhookUrl,
                  type: transition === 'missed' ? 'monitor.missed' : 'monitor.recovered',
                },
                now,
              );
            }
          }
        });
        // Count only after the transaction commits (mirrors the check-in sweep).
        if (!result.ok) {
          metrics.uptimeProbeFailures.inc();
          failures++;
        }
      } catch (err) {
        deps.logger?.error('http probe transition failed', {
          id: m.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return failures;
};

export const startMonitorSweep = (deps: MonitorSweepDeps): MonitorSweepHandle => {
  const intervalMs = deps.intervalMs ?? 60_000;
  const nowFn = deps.now ?? (() => Date.now());
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const runProbes = (now: number): Promise<number> =>
    sweepHttpProbes(deps.db, now, {
      fetchFn,
      lookupFn,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

  const tick = (): void => {
    if (stopped) return;
    const now = nowFn();
    try {
      sweepMonitors(deps.db, now, deps.logger);
      // http probes await network I/O; run them in the background so the tick
      // stays responsive. They must never reject the tick or silently die.
      void runProbes(now).catch((err: unknown) => {
        deps.logger?.error('http probe sweep iteration failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
    probeOnce: (now?: number) => runProbes(now ?? nowFn()),
  };
};
