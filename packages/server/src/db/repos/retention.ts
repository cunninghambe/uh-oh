import { and, inArray, lt } from 'drizzle-orm';

import type { Db } from '../index.js';
import { events, webhookDispatches } from '../schema.js';

const DAY_MS = 86_400_000;
// Terminal (succeeded/failed) webhook dispatch rows are pruned after this many
// days regardless of the event retention window.
const TERMINAL_DISPATCH_RETENTION_DAYS = 7;

export const DEFAULT_RETENTION_DAYS = 90;

export type PruneResult = { eventsDeleted: number; dispatchesDeleted: number };

/**
 * Parse the retention-days env value. Integer, default 90, `0` disables event
 * age-out. Invalid values fall back to the default.
 */
export const resolveRetentionDays = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return n;
};

/**
 * Delete aged-out data:
 *  - events older than `retentionDays` (breadcrumbs + symbolications cascade);
 *    `retentionDays === 0` disables this.
 *  - terminal webhook_dispatches older than 7 days.
 *
 * Issues are intentionally kept as the aggregate history and are never pruned.
 */
export const pruneOldData = (db: Db, opts: { now: number; retentionDays: number }): PruneResult => {
  let eventsDeleted = 0;
  if (opts.retentionDays > 0) {
    const cutoff = opts.now - opts.retentionDays * DAY_MS;
    const res = db.delete(events).where(lt(events.receivedAt, cutoff)).run();
    eventsDeleted = res.changes;
  }

  const dispatchCutoff = opts.now - TERMINAL_DISPATCH_RETENTION_DAYS * DAY_MS;
  const dispatchRes = db
    .delete(webhookDispatches)
    .where(
      and(
        inArray(webhookDispatches.status, ['succeeded', 'failed']),
        lt(webhookDispatches.createdAt, dispatchCutoff),
      ),
    )
    .run();

  return { eventsDeleted, dispatchesDeleted: dispatchRes.changes };
};
