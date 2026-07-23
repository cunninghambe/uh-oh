import { and, desc, eq, gt, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { events, type EventRow } from '../schema.js';

export const insertEvent = (
  db: DbOrTx,
  input: Omit<EventRow, 'id'> & { id?: string },
): EventRow => {
  const row: EventRow = { ...input, id: input.id ?? newId() };
  db.insert(events).values(row).run();
  return row;
};

export const getEvent = (db: DbOrTx, id: string): EventRow | null =>
  db.select().from(events).where(eq(events.id, id)).get() ?? null;

export const listEventsForIssue = (
  db: DbOrTx,
  issueId: string,
  opts: { limit?: number; offset?: number } = {},
): { rows: EventRow[]; total: number } => {
  const rows = db
    .select()
    .from(events)
    .where(eq(events.issueId, issueId))
    .orderBy(desc(events.receivedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .all();
  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.issueId, issueId))
    .get();
  return { rows, total: totalRow?.n ?? 0 };
};

export const getLatestEventForIssue = (db: DbOrTx, issueId: string): EventRow | null =>
  db
    .select()
    .from(events)
    .where(eq(events.issueId, issueId))
    .orderBy(desc(events.receivedAt))
    .limit(1)
    .get() ?? null;

/** True when the issue has any event strictly after `afterMs` (verify-sweep silence check). */
export const hasEventSince = (db: DbOrTx, issueId: string, afterMs: number): boolean =>
  db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.issueId, issueId), gt(events.receivedAt, afterMs)))
    .limit(1)
    .get() !== undefined;
