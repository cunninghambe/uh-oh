import { desc, eq } from 'drizzle-orm';

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
): EventRow[] =>
  db
    .select()
    .from(events)
    .where(eq(events.issueId, issueId))
    .orderBy(desc(events.receivedAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .all();

export const getLatestEventForIssue = (db: DbOrTx, issueId: string): EventRow | null =>
  db
    .select()
    .from(events)
    .where(eq(events.issueId, issueId))
    .orderBy(desc(events.receivedAt))
    .limit(1)
    .get() ?? null;
