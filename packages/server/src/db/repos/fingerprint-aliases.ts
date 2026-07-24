// Fingerprint aliases (v0.9 §24). A merge turns the source issue's fingerprint —
// and every alias that already pointed at the source — into an alias of the
// target. Ingest consults this table BEFORE issues.fingerprint, so an event whose
// computed fingerprint matches an alias is routed to the target issue. There is
// one target per (project, fingerprint) — the UNIQUE index enforces it.

import { and, eq } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { fingerprintAliases } from '../schema.js';

/** The target issue id an alias routes `(projectId, fingerprint)` to, or null. */
export const getAliasTarget = (db: DbOrTx, projectId: string, fingerprint: string): string | null =>
  db
    .select({ issueId: fingerprintAliases.issueId })
    .from(fingerprintAliases)
    .where(
      and(
        eq(fingerprintAliases.projectId, projectId),
        eq(fingerprintAliases.fingerprint, fingerprint),
      ),
    )
    .get()?.issueId ?? null;

/**
 * Point `(projectId, fingerprint)` at `issueId`. Upsert on the unique index so a
 * fingerprint that somehow already had an alias is re-pointed rather than
 * throwing (idempotent — no unmerge, only forward re-pointing).
 */
export const createAlias = (
  db: DbOrTx,
  input: { projectId: string; fingerprint: string; issueId: string },
  now: number,
): void => {
  db.insert(fingerprintAliases)
    .values({
      projectId: input.projectId,
      fingerprint: input.fingerprint,
      issueId: input.issueId,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [fingerprintAliases.projectId, fingerprintAliases.fingerprint],
      set: { issueId: input.issueId, createdAt: now },
    })
    .run();
};

/**
 * Re-point every alias that currently targets `fromIssueId` to `toIssueId`. Used
 * when the source of a merge was itself a target of earlier merges, so those
 * chains collapse onto the new target rather than dangling at the merged source.
 */
export const repointAliases = (db: DbOrTx, fromIssueId: string, toIssueId: string): void => {
  db.update(fingerprintAliases)
    .set({ issueId: toIssueId })
    .where(eq(fingerprintAliases.issueId, fromIssueId))
    .run();
};
