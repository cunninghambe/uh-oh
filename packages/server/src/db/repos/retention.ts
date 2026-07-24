import { and, inArray, lt, notInArray, sql } from 'drizzle-orm';

import type { Db } from '../index.js';
import {
  events,
  fixAttempts,
  issueAnnotations,
  usageEvents,
  usageSalts,
  webhookDispatches,
} from '../schema.js';

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
  annotationsDeleted: number;
  fixAttemptsDeleted: number;
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
 *  - issue_annotations + fix_attempts belonging to DEAD issues, i.e. issues with
 *    no event rows left after the event prune (same 0-disables rule).
 *  - terminal webhook_dispatches older than 7 days.
 *  - usage_salts older than 2 days.
 *
 * Issues are intentionally kept as the aggregate history and are never pruned.
 *
 * Annotations and fix attempts are the institutional memory §23 exists to build,
 * so they are kept for as long as the issue has any event inside the retention
 * window; only an issue whose entire event history has aged out loses them. They
 * are also agent-writable and were previously never pruned at all, which made
 * them the one unbounded table pair on disk (the per-issue cap in
 * `MAX_ANNOTATIONS_PER_ISSUE` bounds the live side).
 */
export const pruneOldData = (db: Db, opts: { now: number; retentionDays: number }): PruneResult => {
  let eventsDeleted = 0;
  let usageEventsDeleted = 0;
  let annotationsDeleted = 0;
  let fixAttemptsDeleted = 0;
  if (opts.retentionDays > 0) {
    const cutoff = opts.now - opts.retentionDays * DAY_MS;
    eventsDeleted = db.delete(events).where(lt(events.receivedAt, cutoff)).run().changes;
    usageEventsDeleted = db
      .delete(usageEvents)
      .where(lt(usageEvents.receivedAt, cutoff))
      .run().changes;

    // Dead issues = those with zero remaining event rows AFTER the prune above.
    // A live issue (any event still inside the window) keeps every annotation
    // and fix attempt it has accumulated.
    const liveIssueIds = sql`(select distinct ${events.issueId} from ${events})`;
    annotationsDeleted = db
      .delete(issueAnnotations)
      .where(notInArray(issueAnnotations.issueId, liveIssueIds))
      .run().changes;
    fixAttemptsDeleted = db
      .delete(fixAttempts)
      .where(notInArray(fixAttempts.issueId, liveIssueIds))
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
    annotationsDeleted,
    fixAttemptsDeleted,
  };
};
