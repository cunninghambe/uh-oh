import { and, eq } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { releases, type ReleaseRow } from '../schema.js';

export type ReleaseInsert = {
  projectId: string;
  version: string;
  build: string;
  platform: 'ios' | 'android' | 'web' | 'node';
};

/**
 * Idempotent release upsert. Returns the existing row (against the
 * project+version+build+platform unique index) when present, otherwise inserts
 * and returns a new one. `created` distinguishes the two so callers (e.g. the
 * release-upsert route) can return 201 vs 200.
 */
export const upsertReleaseWithStatus = (
  db: DbOrTx,
  input: ReleaseInsert,
): { release: ReleaseRow; created: boolean } => {
  const existing = db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.projectId, input.projectId),
        eq(releases.version, input.version),
        eq(releases.build, input.build),
        eq(releases.platform, input.platform),
      ),
    )
    .get();

  if (existing) return { release: existing, created: false };

  const row: ReleaseRow = {
    id: newId(),
    projectId: input.projectId,
    version: input.version,
    build: input.build,
    platform: input.platform,
    mappingUploadedAt: null,
    sourcemapUploadedAt: null,
  };
  db.insert(releases).values(row).run();
  return { release: row, created: true };
};

export const upsertRelease = (db: DbOrTx, input: ReleaseInsert): ReleaseRow =>
  upsertReleaseWithStatus(db, input).release;

export const getReleaseById = (db: DbOrTx, id: string): ReleaseRow | null =>
  db.select().from(releases).where(eq(releases.id, id)).get() ?? null;

export const listReleasesForProject = (db: DbOrTx, projectId: string): ReleaseRow[] =>
  db.select().from(releases).where(eq(releases.projectId, projectId)).all();

export const markMappingUploaded = (db: DbOrTx, id: string, at: number): void => {
  db.update(releases).set({ mappingUploadedAt: at }).where(eq(releases.id, id)).run();
};

export const markSourcemapUploaded = (db: DbOrTx, id: string, at: number): void => {
  db.update(releases).set({ sourcemapUploadedAt: at }).where(eq(releases.id, id)).run();
};
