import { eq } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId, newPublicKey } from '../ids.js';
import { projects, type ProjectRow } from '../schema.js';

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';

export const createProject = (
  db: DbOrTx,
  input: { name: string; slug?: string; webhookUrl?: string },
): ProjectRow => {
  const row: ProjectRow = {
    id: newId(),
    name: input.name,
    slug: input.slug ?? slugify(input.name),
    publicKey: newPublicKey(),
    webhookUrl: input.webhookUrl ?? null,
    alertDedupeMinutes: 30,
    createdAt: Date.now(),
  };
  db.insert(projects).values(row).run();
  return row;
};

export const listProjects = (db: DbOrTx): ProjectRow[] => db.select().from(projects).all();

export const getProjectById = (db: DbOrTx, id: string): ProjectRow | null =>
  db.select().from(projects).where(eq(projects.id, id)).get() ?? null;

export const getProjectByPublicKey = (db: DbOrTx, publicKey: string): ProjectRow | null =>
  db.select().from(projects).where(eq(projects.publicKey, publicKey)).get() ?? null;

export const updateProject = (
  db: DbOrTx,
  id: string,
  patch: Partial<Pick<ProjectRow, 'webhookUrl' | 'alertDedupeMinutes' | 'name'>>,
): ProjectRow | null => {
  const existing = getProjectById(db, id);
  if (!existing) return null;
  db.update(projects).set(patch).where(eq(projects.id, id)).run();
  return getProjectById(db, id);
};

export const rotateProjectPublicKey = (db: DbOrTx, id: string): ProjectRow | null => {
  const existing = getProjectById(db, id);
  if (!existing) return null;
  const publicKey = newPublicKey();
  db.update(projects).set({ publicKey }).where(eq(projects.id, id)).run();
  return getProjectById(db, id);
};

export const deleteProject = (db: DbOrTx, id: string): boolean => {
  const result = db.delete(projects).where(eq(projects.id, id)).run();
  return result.changes > 0;
};
