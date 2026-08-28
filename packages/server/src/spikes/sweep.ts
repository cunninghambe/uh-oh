// CONTRACT S — the spike sweep (v0.8 §23). A 5-minute in-process job (same
// lifecycle pattern as the monitor sweep) that flips an issue into the spiking
// state when its last-hour volume dwarfs its baseline, dispatching `issue.spike`
// ONCE per episode (the state transition is the dedupe, like monitors). The
// condition clearing resets spike_active silently (no webhook).

import type { Db } from '../db/index.js';
import { getProjectById } from '../db/repos/projects.js';
import {
  clearSpikeActive,
  computeSpikeStats,
  isSpiking,
  listSpikeSweepCandidates,
  setSpikeActive,
} from '../db/repos/spikes.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { resolveWebhookUrl, warnNoWebhookTarget } from '../webhooks/resolve-url.js';
import { metrics } from '../metrics/registry.js';

export type SweepLogger = {
  error: (msg: string, meta?: object) => void;
  info?: (msg: string, meta?: object) => void;
  warn?: (msg: string, meta?: object) => void;
};

/** Options for one sweep pass. */
export type SpikeSweepOptions = {
  logger?: SweepLogger | undefined;
  /** Instance-level fallback webhook (UH_OH_DEFAULT_WEBHOOK_URL). */
  defaultWebhookUrl?: string | undefined;
};

export type SpikeSweepDeps = {
  db: Db;
  now?: () => number;
  /** Sweep cadence (default 5 minutes). */
  intervalMs?: number;
  logger?: SweepLogger;
  /**
   * Instance-level fallback webhook used when a project has no webhook_url of
   * its own. Threaded from UH_OH_DEFAULT_WEBHOOK_URL at startup.
   */
  defaultWebhookUrl?: string | undefined;
};

export type SpikeSweepHandle = {
  stop: () => void;
  /** Run one sweep synchronously (used by tests + the scheduled tick). */
  sweepOnce: (now?: number) => number;
};

const isEnterable = (status: string): boolean => status === 'open' || status === 'regressed';

/**
 * Evaluate every candidate issue. Enter spiking (set the flag + last_spike_at,
 * dispatch issue.spike once) on the transition; clear it silently when the
 * condition no longer holds. Each transition is its own transaction so one bad
 * row can't abort the whole sweep. Returns the number of NEW spike episodes.
 */
export const sweepSpikes = (db: Db, now: number, opts: SpikeSweepOptions = {}): number => {
  const { logger, defaultWebhookUrl } = opts;
  let fired = 0;
  for (const c of listSpikeSweepCandidates(db, now)) {
    try {
      const stats = computeSpikeStats(db, c.id, now);
      const spiking = isEnterable(c.status) && isSpiking(stats);
      const wasActive = c.spikeActive === 1;

      if (spiking && !wasActive) {
        db.transaction((tx) => {
          setSpikeActive(tx, c.id, now);
          const project = getProjectById(tx, c.projectId);
          const url = resolveWebhookUrl(project, defaultWebhookUrl);
          if (url) {
            enqueueDispatch(tx, { issueId: c.id, url, type: 'issue.spike' }, now);
          } else if (project) {
            warnNoWebhookTarget(logger, project, 'issue.spike');
          }
        });
        // Count only after the transaction commits (mirrors the monitor sweep).
        metrics.issueSpikes.inc();
        fired++;
      } else if (!spiking && wasActive) {
        clearSpikeActive(db, c.id);
      }
    } catch (err) {
      logger?.error('spike sweep transition failed', {
        id: c.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return fired;
};

export const startSpikeSweep = (deps: SpikeSweepDeps): SpikeSweepHandle => {
  const intervalMs = deps.intervalMs ?? 5 * 60_000;
  const nowFn = deps.now ?? (() => Date.now());
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sweepOptions: SpikeSweepOptions = {
    logger: deps.logger,
    defaultWebhookUrl: deps.defaultWebhookUrl,
  };

  const tick = (): void => {
    if (stopped) return;
    try {
      sweepSpikes(deps.db, nowFn(), sweepOptions);
    } catch (err) {
      // The sweep must never silently die; log and keep scheduling.
      deps.logger?.error('spike sweep iteration failed', {
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
    sweepOnce: (now?: number) => sweepSpikes(deps.db, now ?? nowFn(), sweepOptions),
  };
};
