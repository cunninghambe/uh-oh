// Issue merge (v0.9 §24). Fold a source issue into a target, atomically: move the
// source's events, annotations, and fix attempts onto the target; recompute the
// target's counts; make the source's fingerprint (and any aliases already
// pointing at it) route to the target; clear the source's spike state; and flip
// the source to the terminal 'merged' status. The whole thing runs inside one
// transaction supplied by the caller — a partial merge must never be observable.

import { eq, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { events, issueAnnotations, issues, type IssueRow } from '../schema.js';
import { writeSystemAnnotation } from './annotations.js';
import { createAlias, repointAliases } from './fingerprint-aliases.js';

/**
 * Merge `source` into `target`. Callers validate the pair first (same project,
 * distinct, target not itself merged) and run this inside a transaction. Returns
 * nothing; read the target back for the recomputed row.
 */
export const mergeIssueInto = (
  db: DbOrTx,
  source: IssueRow,
  target: IssueRow,
  now: number,
): void => {
  // 1. Re-point every source event onto the target (the event keeps its own
  //    fingerprint; only its issue changes).
  db.update(events).set({ issueId: target.id }).where(eq(events.issueId, source.id)).run();

  // 2. Combine the issue counters ADDITIVELY from the two issue rows, not by
  //    recounting event rows: rate-limited floods bump event_count without
  //    inserting rows (edge case 4), so a row recount would silently shrink a
  //    flooded issue's count. The issue rows are the authoritative tallies.
  db.update(issues)
    .set({
      eventCount: target.eventCount + source.eventCount,
      firstSeen: Math.min(target.firstSeen, source.firstSeen),
      lastSeen: Math.max(target.lastSeen, source.lastSeen),
    })
    .where(eq(issues.id, target.id))
    .run();

  // 3. The source's fingerprint — and any aliases already pointing at the source
  //    (collapsing earlier merge chains) — become aliases of the target.
  repointAliases(db, source.id, target.id);
  createAlias(
    db,
    { projectId: source.projectId, fingerprint: source.fingerprint, issueId: target.id },
    now,
  );

  // 4. Move the investigation record. Annotations have no unique constraint, so
  //    all move. Fix attempts are UNIQUE(issue_id, pr_url): move the PRs the
  //    target lacks and drop any source duplicate of a PR the target already has,
  //    so the move can never violate the constraint and abort the merge.
  db.update(issueAnnotations)
    .set({ issueId: target.id })
    .where(eq(issueAnnotations.issueId, source.id))
    .run();
  db.run(sql`
    UPDATE fix_attempts SET issue_id = ${target.id}
    WHERE issue_id = ${source.id}
      AND pr_url NOT IN (SELECT pr_url FROM fix_attempts WHERE issue_id = ${target.id})
  `);
  db.run(sql`DELETE FROM fix_attempts WHERE issue_id = ${source.id}`);
  writeSystemAnnotation(db, target.id, `merged from "${source.title}"`, now);

  // 5. Clear the source's spike state and flip it to the terminal status.
  db.update(issues)
    .set({ spikeActive: false, lastSpikeAt: null, status: 'merged' })
    .where(eq(issues.id, source.id))
    .run();
};
