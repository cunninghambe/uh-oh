// Spike detection stats (v0.8 §23). A 5-minute sweep flags an issue as spiking
// when its last-hour event volume dwarfs its recent baseline. All counts are
// windowed over the (issue_id, received_at) index; the threshold is a pure
// function of the two counts so the sweep and the webhook payload agree exactly
// when both compute as-of the same reference time.

import { eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { issues } from '../schema.js';

const HOUR_MS = 3_600_000;
/** Floor on lastHour before an issue can spike (kills low-volume noise). */
export const SPIKE_ABSOLUTE_MIN = 10;
/** lastHour must beat this multiple of the hourly baseline to spike. */
export const SPIKE_MULTIPLIER = 5;

export type SpikeStats = { lastHour: number; baselineHourly: number };

/**
 * `lastHour` = events in [now−1h, now]; `baselineHourly` = events in
 * [now−25h, now−1h] averaged per hour (÷ 24). The shared now−1h boundary is
 * counted in lastHour only (baseline upper bound is half-open) so an event is
 * never double-counted.
 */
export const computeSpikeStats = (db: DbOrTx, issueId: string, now: number): SpikeStats => {
  const row = db.get<{ lastHour: number; baseline: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM events
        WHERE issue_id = ${issueId}
          AND received_at >= ${now - HOUR_MS} AND received_at <= ${now}) AS lastHour,
      (SELECT COUNT(*) FROM events
        WHERE issue_id = ${issueId}
          AND received_at >= ${now - 25 * HOUR_MS} AND received_at < ${now - HOUR_MS}) AS baseline
  `);
  const lastHour = row?.lastHour ?? 0;
  const baseline = row?.baseline ?? 0;
  return { lastHour, baselineHourly: baseline / 24 };
};

/** The spiking predicate: lastHour ≥ max(10, 5 × baselineHourly). */
export const isSpiking = (stats: SpikeStats): boolean =>
  stats.lastHour >= Math.max(SPIKE_ABSOLUTE_MIN, SPIKE_MULTIPLIER * stats.baselineHourly);

export type SpikeCandidate = {
  id: string;
  projectId: string;
  status: string;
  // Raw SQLite 0/1 (this is a hand-written SELECT, not a Drizzle boolean column).
  spikeActive: number;
};

/**
 * The sweep's candidate set: open/regressed issues seen within the past hour
 * (which can ENTER spiking), plus every already-spiking issue regardless of
 * status/recency (so a spike that ended still gets re-evaluated and cleared).
 */
export const listSpikeSweepCandidates = (db: DbOrTx, now: number): SpikeCandidate[] =>
  db.all<SpikeCandidate>(sql`
    SELECT id, project_id AS projectId, status, spike_active AS spikeActive
    FROM issues
    WHERE spike_active = 1
       OR (status IN ('open', 'regressed') AND last_seen >= ${now - HOUR_MS})
    ORDER BY id ASC
  `);

/** Enter the spiking state: set the flag and stamp last_spike_at. */
export const setSpikeActive = (db: DbOrTx, issueId: string, now: number): void => {
  db.update(issues)
    .set({ spikeActive: true, lastSpikeAt: now })
    .where(eq(issues.id, issueId))
    .run();
};

/** Leave the spiking state silently (no webhook); last_spike_at is preserved. */
export const clearSpikeActive = (db: DbOrTx, issueId: string): void => {
  db.update(issues).set({ spikeActive: false }).where(eq(issues.id, issueId)).run();
};
