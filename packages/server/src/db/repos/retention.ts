import { and, inArray, lt } from 'drizzle-orm';

import type { Db } from '../index.js';
import { events, usageEvents, usageSalts, webhookDispatches } from '../schema.js';

const DAY_MS = 86_400_000;
// Terminal (succeeded/failed) webhook dispatch rows are pruned after this many
// days regardless of the event retention window.
const TERMINAL_DISPATCH_RETENTION_DAYS = 7;
// Daily visitor salts only need to outlive same-day hashing; older salts are
// dead weight (and best not kept around), so prune once >2 days old.
const SALT_RETENTION_DAYS = 2;

export const DEFAULT_RETENTION_DAYS = 90;

export type PruneResult = {
  eventsDeleted: number;
  dispatchesDeleted: number;
  usageEventsDeleted: number;
  usageSaltsDeleted: number;
};

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
 *  - usage_events older than `retentionDays` (same window; disabled at 0).
 *  - terminal webhook_dispatches older than 7 days.
 *  - usage_salts older than 2 days.
 *
 * Issues are intentionally kept as the aggregate history and are never pruned.
 */
export const pruneOldData = (db: Db, opts: { now: number; retentionDays: number }): PruneResult => {
  let eventsDeleted = 0;
  let usageEventsDeleted = 0;
  if (opts.retentionDays > 0) {
    const cutoff = opts.now - opts.retentionDays * DAY_MS;
    eventsDeleted = db.delete(events).where(lt(events.receivedAt, cutoff)).run().changes;
    usageEventsDeleted = db
      .delete(usageEvents)
      .where(lt(usageEvents.receivedAt, cutoff))
      .run().changes;
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

  // Salts are keyed by their 'YYYY-MM-DD' UTC day, so a lexical `<` on the cutoff
  // date string is the correct age comparison.
  const saltCutoffDate = new Date(opts.now - SALT_RETENTION_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const saltsRes = db.delete(usageSalts).where(lt(usageSalts.date, saltCutoffDate)).run();

  return {
    eventsDeleted,
    dispatchesDeleted: dispatchRes.changes,
    usageEventsDeleted,
    usageSaltsDeleted: saltsRes.changes,
  };
};
