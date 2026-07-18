// list_top_issues backing query — open + regressed issues across ALL projects,
// ranked by event volume within the stats window (last N UTC days). Uses the
// (issue_id, received_at) index via the join predicate; no new tables. The
// INNER JOIN on windowed events naturally drops issues silent in the window.

import { sql } from 'drizzle-orm';

import type { TopIssue } from '@uh-oh/mcp';

import type { DbOrTx } from '../index.js';
import { statsWindowLowerMs } from './stats.js';

export const topIssues = (
  db: DbOrTx,
  input: { limit: number; days: number; now?: number },
): TopIssue[] => {
  const now = input.now ?? Date.now();
  const lowerMs = statsWindowLowerMs(input.days, now);
  return db.all<TopIssue>(sql`
    SELECT
      i.id AS issueId,
      i.title AS title,
      i.status AS status,
      i.platform AS platform,
      i.project_id AS projectId,
      p.slug AS projectSlug,
      p.name AS projectName,
      i.event_count AS eventCount,
      i.first_seen AS firstSeen,
      i.last_seen AS lastSeen,
      COUNT(e.id) AS windowEvents
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    JOIN events e ON e.issue_id = i.id AND e.received_at >= ${lowerMs}
    WHERE i.status IN ('open', 'regressed')
    GROUP BY i.id
    ORDER BY windowEvents DESC, i.last_seen DESC, i.id ASC
    LIMIT ${input.limit}
  `);
};
