// Agent-loop investigation notes (v0.8 §23). Free-text annotations an agent (or
// the server, kind 'system') accretes on an issue so the next investigation of
// the same crash does not start from zero. Listing is always newest-first, with
// a deterministic id tie-break so equal-timestamp rows never depend on row order.

import { desc, eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { issueAnnotations, type IssueAnnotationRow } from '../schema.js';

export type AnnotationKind = 'note' | 'root_cause' | 'fix_plan' | 'verification' | 'system';

/** The kinds a client may set. 'system' is server-only (fix-attempt audit trail). */
export const CLIENT_ANNOTATION_KINDS: readonly AnnotationKind[] = [
  'note',
  'root_cause',
  'fix_plan',
  'verification',
];

/** Max body size (bytes ≈ chars; enforced by the route as a 413). */
export const MAX_ANNOTATION_BODY = 16 * 1024;
/** Max author length. */
export const MAX_ANNOTATION_AUTHOR = 128;

export const createAnnotation = (
  db: DbOrTx,
  input: { issueId: string; body: string; kind?: AnnotationKind; author?: string },
  now: number,
): IssueAnnotationRow => {
  const row: IssueAnnotationRow = {
    id: newId(),
    issueId: input.issueId,
    author: input.author && input.author.length > 0 ? input.author : 'agent',
    kind: input.kind ?? 'note',
    body: input.body,
    createdAt: now,
  };
  db.insert(issueAnnotations).values(row).run();
  return row;
};

export const listAnnotations = (
  db: DbOrTx,
  issueId: string,
  opts: { limit?: number; offset?: number } = {},
): { rows: IssueAnnotationRow[]; total: number } => {
  const rows = db
    .select()
    .from(issueAnnotations)
    .where(eq(issueAnnotations.issueId, issueId))
    .orderBy(desc(issueAnnotations.createdAt), desc(issueAnnotations.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0)
    .all();
  const totalRow = db
    .select({ n: sql<number>`count(*)` })
    .from(issueAnnotations)
    .where(eq(issueAnnotations.issueId, issueId))
    .get();
  return { rows, total: totalRow?.n ?? 0 };
};

/** The newest `limit` annotations for an issue (bundle uses the last 10). */
export const listRecentAnnotations = (
  db: DbOrTx,
  issueId: string,
  limit: number,
): IssueAnnotationRow[] =>
  db
    .select()
    .from(issueAnnotations)
    .where(eq(issueAnnotations.issueId, issueId))
    .orderBy(desc(issueAnnotations.createdAt), desc(issueAnnotations.id))
    .limit(limit)
    .all();

export const countAnnotations = (db: DbOrTx, issueId: string): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(issueAnnotations)
    .where(eq(issueAnnotations.issueId, issueId))
    .get()?.n ?? 0;

/**
 * The server-written audit-trail annotation for a fix-attempt state transition
 * (kind 'system'). Shared by the PATCH route, the ingest regression hook, and
 * the verify sweep so every transition leaves the same record.
 */
export const writeSystemAnnotation = (
  db: DbOrTx,
  issueId: string,
  body: string,
  now: number,
): IssueAnnotationRow =>
  createAnnotation(db, { issueId, body, kind: 'system', author: 'system' }, now);

/** Wire shape for an annotation (issue detail, bundle, POST response). */
export type AnnotationView = {
  id: string;
  issueId: string;
  author: string;
  kind: AnnotationKind;
  body: string;
  createdAt: number;
};

export const toAnnotationView = (row: IssueAnnotationRow): AnnotationView => ({
  id: row.id,
  issueId: row.issueId,
  author: row.author,
  kind: row.kind,
  body: row.body,
  createdAt: row.createdAt,
});
