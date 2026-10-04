import { and, count, eq, lte, max } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { webhookDispatches, type WebhookDispatchRow } from '../schema.js';

export type DispatchType =
  | 'issue.new'
  | 'issue.regressed'
  | 'monitor.missed'
  | 'monitor.recovered'
  | 'issue.spike'
  | 'fix.verified';

export type DispatchInsert = {
  // Set for issue.* / fix.* dispatches; null/omitted for monitor.* dispatches.
  issueId?: string | null;
  // Set only for issue.new / issue.regressed (the event that fired the alert);
  // issue.spike and fix.verified carry no event.
  eventId?: string | null;
  // Set for monitor.* dispatches; null/omitted otherwise.
  monitorId?: string | null;
  url: string;
  /** Webhook body `type`. Defaults to 'issue.new' when omitted. */
  type?: DispatchType;
};

export const enqueueDispatch = (
  db: DbOrTx,
  input: DispatchInsert,
  now: number,
): WebhookDispatchRow => {
  const row: WebhookDispatchRow = {
    id: newId(),
    issueId: input.issueId ?? null,
    eventId: input.eventId ?? null,
    monitorId: input.monitorId ?? null,
    url: input.url,
    type: input.type ?? 'issue.new',
    attempt: 0,
    nextAttemptAt: now,
    status: 'pending',
    lastError: null,
    lastResponseCode: null,
    createdAt: now,
  };
  db.insert(webhookDispatches).values(row).run();
  return row;
};

export const takeDueDispatches = (db: DbOrTx, now: number, limit: number): WebhookDispatchRow[] =>
  db
    .select()
    .from(webhookDispatches)
    .where(and(eq(webhookDispatches.status, 'pending'), lte(webhookDispatches.nextAttemptAt, now)))
    .limit(limit)
    .all();

type AttemptOk = { ok: true; statusCode: number; at: number };
type AttemptFail = {
  ok: false;
  statusCode: number | null;
  error: string;
  at: number;
  nextAttemptAt: number | null;
};

export const markDispatchAttempt = (
  db: DbOrTx,
  id: string,
  result: AttemptOk | AttemptFail,
): void => {
  if (result.ok) {
    db.update(webhookDispatches)
      .set({ status: 'succeeded', lastResponseCode: result.statusCode })
      .where(eq(webhookDispatches.id, id))
      .run();
    return;
  }

  if (result.nextAttemptAt === null) {
    // A failed row is never attempted again, so its next_attempt_at is free to
    // record when the final attempt happened. summarizeFailedDispatches reads
    // it as the failure time.
    db.update(webhookDispatches)
      .set({
        status: 'failed',
        nextAttemptAt: result.at,
        lastError: result.error,
        lastResponseCode: result.statusCode,
      })
      .where(eq(webhookDispatches.id, id))
      .run();
    return;
  }

  const current = db
    .select({ attempt: webhookDispatches.attempt })
    .from(webhookDispatches)
    .where(eq(webhookDispatches.id, id))
    .get();

  db.update(webhookDispatches)
    .set({
      status: 'pending',
      attempt: (current?.attempt ?? 0) + 1,
      nextAttemptAt: result.nextAttemptAt,
      lastError: result.error,
      lastResponseCode: result.statusCode,
    })
    .where(eq(webhookDispatches.id, id))
    .run();
};

export type FailedDispatchSummary = {
  /** Dispatches that failed permanently and are still in the table. */
  failed: number;
  /** Epoch ms of the most recent permanent failure, or null when there is none. */
  lastFailedAt: number | null;
};

/**
 * Permanently failed webhook dispatches, read from the table so the figure
 * survives a restart (the `uh_oh_webhook_failures_total` counter starts at 0 in
 * every new process). The window is bounded by retention: pruneOldData deletes
 * terminal rows 7 days after they were enqueued. A row marked failed before
 * markDispatchAttempt recorded the failure time still holds the time its final
 * attempt was scheduled for, which is within one poll of when it ran.
 */
export const summarizeFailedDispatches = (db: DbOrTx): FailedDispatchSummary => {
  const row = db
    .select({ failed: count(), lastFailedAt: max(webhookDispatches.nextAttemptAt) })
    .from(webhookDispatches)
    .where(eq(webhookDispatches.status, 'failed'))
    .get();
  return { failed: row?.failed ?? 0, lastFailedAt: row?.lastFailedAt ?? null };
};
