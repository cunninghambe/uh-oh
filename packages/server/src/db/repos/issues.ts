import { and, desc, eq, sql, asc } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { issues, type IssueRow } from '../schema.js';

export type IssueStatus = 'open' | 'resolved' | 'ignored';

export const upsertIssue = (
  db: DbOrTx,
  input: { projectId: string; fingerprint: string; title: string; ts: number },
): { issue: IssueRow; isNew: boolean } => {
  // Atomic upsert: a single INSERT ... ON CONFLICT DO UPDATE avoids the
  // SELECT-then-write race where two concurrent events could both insert.
  // On conflict we bump lastSeen + eventCount but preserve title, status,
  // firstSeen and lastAlertedAt (a resolved issue receiving a new event stays
  // resolved — matching the prior behavior).
  const issue = db
    .insert(issues)
    .values({
      id: newId(),
      projectId: input.projectId,
      fingerprint: input.fingerprint,
      title: input.title,
      firstSeen: input.ts,
      lastSeen: input.ts,
      eventCount: 1,
      status: 'open',
      lastAlertedAt: null,
    })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.fingerprint],
      set: {
        lastSeen: input.ts,
        eventCount: sql`${issues.eventCount} + 1`,
      },
    })
    .returning()
    .get();

  // A freshly inserted issue has eventCount 1; a conflict update makes it >= 2.
  return { issue, isNew: issue.eventCount === 1 };
};

export type IssueSort = 'lastSeen' | 'eventCount' | 'firstSeen';

const sortColumn = (sort: IssueSort) => {
  if (sort === 'eventCount') return desc(issues.eventCount);
  if (sort === 'firstSeen') return asc(issues.firstSeen);
  return desc(issues.lastSeen);
};

export const listIssues = (
  db: DbOrTx,
  input: {
    projectId: string;
    status?: IssueStatus;
    sort?: IssueSort;
    limit?: number;
    offset?: number;
  },
): { rows: IssueRow[]; total: number } => {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const where = input.status
    ? and(eq(issues.projectId, input.projectId), eq(issues.status, input.status))
    : eq(issues.projectId, input.projectId);

  const rows = db
    .select()
    .from(issues)
    .where(where)
    .orderBy(sortColumn(input.sort ?? 'lastSeen'))
    .limit(limit)
    .offset(offset)
    .all();

  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(issues)
    .where(where)
    .get();
  return { rows, total: totalRow?.n ?? 0 };
};

export const getIssue = (db: DbOrTx, id: string): IssueRow | null =>
  db.select().from(issues).where(eq(issues.id, id)).get() ?? null;

export const setIssueStatus = (db: DbOrTx, id: string, status: IssueStatus): IssueRow | null => {
  const existing = getIssue(db, id);
  if (!existing) return null;
  db.update(issues).set({ status }).where(eq(issues.id, id)).run();
  return getIssue(db, id);
};

export const markIssueAlerted = (db: DbOrTx, id: string, ts: number): void => {
  db.update(issues).set({ lastAlertedAt: ts }).where(eq(issues.id, id)).run();
};
