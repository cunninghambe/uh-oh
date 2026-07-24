// Fix attempts (v0.8 §23). A fix attempt is tracked from `filed` -> `deployed`
// -> {`verified`|`failed`}. It is UNIQUE per (issue, pr_url), so re-recording a
// PR upserts. `verified` is system-set only (the hourly verify sweep); `failed`
// is set by a client PATCH or by the ingest regression hook when a post-deploy
// event proves the fix did not hold. State changes never mutate created_at; they
// bump updated_at, and marking `deployed` stamps deployed_at.

import { and, desc, eq, isNotNull, lte, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { fixAttempts, type FixAttemptRow } from '../schema.js';

export type FixAttemptState = 'filed' | 'deployed' | 'verified' | 'failed';

/** Commit SHA shape shared with releases.commit_sha. */
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
/** Max PR URL length. */
export const MAX_PR_URL = 512;

/**
 * Client-permitted state transitions. `verified` is system-set only, so it is
 * absent from every target set; a client PATCH to it (or any other unlisted
 * pair) is a 400.
 */
export const ALLOWED_CLIENT_TRANSITIONS: Record<FixAttemptState, readonly FixAttemptState[]> = {
  filed: ['deployed', 'failed'],
  deployed: ['failed'],
  verified: [],
  failed: [],
};

export const isAllowedClientTransition = (from: FixAttemptState, to: FixAttemptState): boolean =>
  ALLOWED_CLIENT_TRANSITIONS[from].includes(to);

/**
 * Upsert by (issue, pr_url). A new row starts `filed`; an existing row is
 * returned unchanged EXCEPT that a provided-and-different commitSha updates it
 * (state is never reset by a re-record — only PATCH transitions state).
 */
export const upsertFixAttempt = (
  db: DbOrTx,
  input: { issueId: string; prUrl: string; commitSha?: string | null },
  now: number,
): { attempt: FixAttemptRow; created: boolean } => {
  const existing = db
    .select()
    .from(fixAttempts)
    .where(and(eq(fixAttempts.issueId, input.issueId), eq(fixAttempts.prUrl, input.prUrl)))
    .get();

  if (existing) {
    if (input.commitSha != null && input.commitSha !== existing.commitSha) {
      db.update(fixAttempts)
        .set({ commitSha: input.commitSha, updatedAt: now })
        .where(eq(fixAttempts.id, existing.id))
        .run();
      return {
        attempt: { ...existing, commitSha: input.commitSha, updatedAt: now },
        created: false,
      };
    }
    return { attempt: existing, created: false };
  }

  const row: FixAttemptRow = {
    id: newId(),
    issueId: input.issueId,
    prUrl: input.prUrl,
    commitSha: input.commitSha ?? null,
    state: 'filed',
    createdAt: now,
    deployedAt: null,
    updatedAt: now,
  };
  db.insert(fixAttempts).values(row).run();
  return { attempt: row, created: true };
};

export const getFixAttempt = (db: DbOrTx, id: string): FixAttemptRow | null =>
  db.select().from(fixAttempts).where(eq(fixAttempts.id, id)).get() ?? null;

/**
 * Apply a state change to a fix attempt. Marking `deployed` stamps deployed_at
 * (only if not already set). Always bumps updated_at. Returns the fresh row.
 */
export const applyFixAttemptTransition = (
  db: DbOrTx,
  attempt: FixAttemptRow,
  to: FixAttemptState,
  now: number,
  opts: { commitSha?: string | null } = {},
): FixAttemptRow => {
  const set: Partial<FixAttemptRow> = { state: to, updatedAt: now };
  if (to === 'deployed' && attempt.deployedAt === null) set.deployedAt = now;
  if (opts.commitSha != null) set.commitSha = opts.commitSha;
  db.update(fixAttempts).set(set).where(eq(fixAttempts.id, attempt.id)).run();
  return getFixAttempt(db, attempt.id) ?? { ...attempt, ...set };
};

/** Update just the commitSha (PATCH may set it without a state change). */
export const setFixAttemptCommit = (
  db: DbOrTx,
  id: string,
  commitSha: string,
  now: number,
): void => {
  db.update(fixAttempts).set({ commitSha, updatedAt: now }).where(eq(fixAttempts.id, id)).run();
};

/** Fix attempts for an issue, newest first (deterministic id tie-break). */
export const listFixAttempts = (db: DbOrTx, issueId: string): FixAttemptRow[] =>
  db
    .select()
    .from(fixAttempts)
    .where(eq(fixAttempts.issueId, issueId))
    .orderBy(desc(fixAttempts.createdAt), desc(fixAttempts.id))
    .all();

/**
 * The most-recently-deployed attempt for an issue (greatest deployed_at, with a
 * deterministic created_at/id tie-break) whose deploy happened at or before
 * `asOf`. This is the attempt a regression fails and the one the regressed /
 * fix.verified webhook payloads reference. Returns null when the issue has no
 * deployed attempt.
 */
export const mostRecentlyDeployedAttempt = (
  db: DbOrTx,
  issueId: string,
  asOf: number,
): FixAttemptRow | null =>
  db
    .select()
    .from(fixAttempts)
    .where(
      and(
        eq(fixAttempts.issueId, issueId),
        isNotNull(fixAttempts.deployedAt),
        lte(fixAttempts.deployedAt, asOf),
      ),
    )
    .orderBy(desc(fixAttempts.deployedAt), desc(fixAttempts.createdAt), desc(fixAttempts.id))
    .limit(1)
    .get() ?? null;

/**
 * Deployed attempts whose deploy is old enough to verify (deployed_at <=
 * `deployedBefore`), fleet-wide, oldest deploy first. The verify sweep then
 * checks each issue for silence since deployed_at.
 */
export const listDeployedAttemptsToVerify = (db: DbOrTx, deployedBefore: number): FixAttemptRow[] =>
  db
    .select()
    .from(fixAttempts)
    .where(and(eq(fixAttempts.state, 'deployed'), lte(fixAttempts.deployedAt, deployedBefore)))
    .orderBy(desc(fixAttempts.deployedAt), desc(fixAttempts.id))
    .all();

export const countVerifiedForIssue = (db: DbOrTx, issueId: string): number =>
  db
    .select({ n: sql<number>`count(*)` })
    .from(fixAttempts)
    .where(and(eq(fixAttempts.issueId, issueId), eq(fixAttempts.state, 'verified')))
    .get()?.n ?? 0;

/** Wire shape for a fix attempt (issue detail, bundle, webhook payloads). */
export type FixAttemptView = {
  id: string;
  issueId: string;
  prUrl: string;
  commitSha: string | null;
  state: FixAttemptState;
  createdAt: number;
  deployedAt: number | null;
  updatedAt: number;
};

export const toFixAttemptView = (row: FixAttemptRow): FixAttemptView => ({
  id: row.id,
  issueId: row.issueId,
  prUrl: row.prUrl,
  commitSha: row.commitSha,
  state: row.state,
  createdAt: row.createdAt,
  deployedAt: row.deployedAt,
  updatedAt: row.updatedAt,
});
