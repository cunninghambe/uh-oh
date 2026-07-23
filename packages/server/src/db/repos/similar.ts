// Similar issues (v0.8 §23). "Have we seen this before, and what fixed it" in one
// deterministic query — no embeddings. Two issues are similar when they share an
// exception-type prefix: the title text before the first ':' (or the whole title
// when it has none). Ranked by has-verified-fix, then annotation count, then
// recency, with an id tie-break so the order never depends on row order.

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { getIssue } from './issues.js';
import { listFixAttempts, toFixAttemptView, type FixAttemptView } from './fix-attempts.js';

/** Max similar issues returned. */
export const MAX_SIMILAR = 10;

export type SimilarIssue = {
  issue: {
    id: string;
    projectId: string;
    projectSlug: string;
    title: string;
    status: string;
    platform: string | null;
    lastSeen: number;
    eventCount: number;
  };
  fixAttempts: FixAttemptView[];
  annotationCount: number;
};

/** The exception-type key of a title: text before the first ':', else the whole. */
export const exceptionKey = (title: string): string => {
  const i = title.indexOf(':');
  return i >= 0 ? title.slice(0, i) : title;
};

type Row = SimilarIssue['issue'] & { annotationCount: number };

export const similarIssues = (db: DbOrTx, issueId: string): SimilarIssue[] => {
  const source = getIssue(db, issueId);
  if (!source) return [];
  const key = exceptionKey(source.title);

  // Candidate key computed the same way in SQL; equality is the match.
  const rows = db.all<Row>(sql`
    SELECT
      i.id AS id,
      i.project_id AS projectId,
      p.slug AS projectSlug,
      i.title AS title,
      i.status AS status,
      i.platform AS platform,
      i.last_seen AS lastSeen,
      i.event_count AS eventCount,
      (SELECT COUNT(*) FROM issue_annotations a WHERE a.issue_id = i.id) AS annotationCount
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.id != ${issueId}
      AND (CASE WHEN instr(i.title, ':') > 0
                THEN substr(i.title, 1, instr(i.title, ':') - 1)
                ELSE i.title END) = ${key}
    ORDER BY
      (EXISTS (SELECT 1 FROM fix_attempts fa WHERE fa.issue_id = i.id AND fa.state = 'verified')) DESC,
      annotationCount DESC,
      i.last_seen DESC,
      i.id ASC
    LIMIT ${MAX_SIMILAR}
  `);

  return rows.map((r) => ({
    issue: {
      id: r.id,
      projectId: r.projectId,
      projectSlug: r.projectSlug,
      title: r.title,
      status: r.status,
      platform: r.platform,
      lastSeen: r.lastSeen,
      eventCount: r.eventCount,
    },
    fixAttempts: listFixAttempts(db, r.id).map(toFixAttemptView),
    annotationCount: r.annotationCount,
  }));
};
