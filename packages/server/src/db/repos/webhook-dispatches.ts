import { and, eq, lte } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { webhookDispatches, type WebhookDispatchRow } from '../schema.js';

export type DispatchType = 'issue.new' | 'issue.regressed' | 'monitor.missed' | 'monitor.recovered';

export type DispatchInsert = {
  // Set for issue.* dispatches; null/omitted for monitor.* dispatches.
  issueId?: string | null;
  eventId?: string | null;
  // Set for monitor.* dispatches; null/omitted for issue.* dispatches.
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
    db.update(webhookDispatches)
      .set({ status: 'failed', lastError: result.error, lastResponseCode: result.statusCode })
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
