import { asc, eq } from 'drizzle-orm';

import type { Db } from '../index.js';
import { breadcrumbs, type BreadcrumbRow } from '../schema.js';

export const insertBreadcrumbs = (
  db: Db,
  eventId: string,
  rows: Array<Omit<BreadcrumbRow, 'eventId' | 'idx'>>,
): void => {
  if (rows.length === 0) return;
  const toInsert: BreadcrumbRow[] = rows.map((r, idx) => ({ ...r, eventId, idx }));
  db.insert(breadcrumbs).values(toInsert).run();
};

export const listBreadcrumbs = (db: Db, eventId: string): BreadcrumbRow[] =>
  db
    .select()
    .from(breadcrumbs)
    .where(eq(breadcrumbs.eventId, eventId))
    .orderBy(asc(breadcrumbs.idx))
    .all();
