import { and, desc, eq, ne, sql, asc } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { issues, type IssueRow } from '../schema.js';

// 'merged' (v0.9 §24) is a system-set terminal status. It is a valid explicit
// filter but never a user-settable PATCH target, and default listings hide it.
export type IssueStatus = 'open' | 'resolved' | 'ignored' | 'regressed' | 'merged';

export type IssuePlatform = 'ios' | 'android' | 'web' | 'node';

export const upsertIssue = (
  db: DbOrTx,
  input: {
    projectId: string;
    fingerprint: string;
    title: string;
    ts: number;
    platform?: IssuePlatform;
  },
): { issue: IssueRow; isNew: boolean; regressed: boolean } => {
  // Read the prior status (if any) before the upsert so we can detect the
  // resolved -> regressed transition. better-sqlite3 is synchronous and this
  // runs inside the ingest transaction, so there is no SELECT-then-write race.
  const prior = db
    .select({ status: issues.status })
    .from(issues)
    .where(and(eq(issues.projectId, input.projectId), eq(issues.fingerprint, input.fingerprint)))
    .get();

  // Atomic upsert: a single INSERT ... ON CONFLICT DO UPDATE avoids the
  // SELECT-then-write race where two concurrent events could both insert.
  // On conflict we bump lastSeen + eventCount and preserve title, firstSeen and
  // lastAlertedAt. Status is preserved EXCEPT that a 'resolved' issue receiving
  // a new event transitions to 'regressed' (open/ignored/regressed unchanged).
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
      platform: input.platform ?? null,
    })
    .onConflictDoUpdate({
      target: [issues.projectId, issues.fingerprint],
      set: {
        lastSeen: input.ts,
        eventCount: sql`${issues.eventCount} + 1`,
        status: sql`CASE WHEN ${issues.status} = 'resolved' THEN 'regressed' ELSE ${issues.status} END`,
        // An issue reflects its LATEST platform: overwrite with the incoming
        // event's platform on every conflict.
        platform: input.platform ?? null,
      },
    })
    .returning()
    .get();

  const isNew = prior === undefined;
  // The transition fires exactly once: the first event after a 'resolved' issue.
  const regressed = prior?.status === 'resolved';
  return { issue, isNew, regressed };
};

/**
 * Bump an EXISTING issue for an aliased event (§24 merge routing). Applies the
 * same conflict-update semantics as {@link upsertIssue} — grow eventCount, move
 * lastSeen forward, transition a 'resolved' issue to 'regressed', overwrite
 * platform — but against a known target id rather than a (project, fingerprint)
 * pair. The event keeps its own computed fingerprint; only the issue is the
 * merge target. Returns the fresh issue and whether this bump regressed it.
 */
export const bumpAliasedIssue = (
  db: DbOrTx,
  targetId: string,
  input: { ts: number; platform?: IssuePlatform },
): { issue: IssueRow; regressed: boolean } | null => {
  const prior = db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, targetId))
    .get();
  if (prior === undefined) return null;

  const issue = db
    .update(issues)
    .set({
      lastSeen: input.ts,
      eventCount: sql`${issues.eventCount} + 1`,
      status: sql`CASE WHEN ${issues.status} = 'resolved' THEN 'regressed' ELSE ${issues.status} END`,
      platform: input.platform ?? null,
    })
    .where(eq(issues.id, targetId))
    .returning()
    .get();

  return { issue, regressed: prior.status === 'resolved' };
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
  // A merged issue is hidden from the default listing; it surfaces only when
  // explicitly filtered with status='merged' (§24).
  const where = input.status
    ? and(eq(issues.projectId, input.projectId), eq(issues.status, input.status))
    : and(eq(issues.projectId, input.projectId), ne(issues.status, 'merged'));

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
