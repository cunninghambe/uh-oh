import { eq, lt } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { sessions } from '../schema.js';

export const insertSession = (db: DbOrTx, jti: string, expiresAt: number): void => {
  db.insert(sessions).values({ jti, expiresAt }).run();
};

export const sessionExists = (db: DbOrTx, jti: string, now: number): boolean => {
  const row = db.select().from(sessions).where(eq(sessions.jti, jti)).get();
  if (!row) return false;
  return row.expiresAt > now;
};

export const deleteSession = (db: DbOrTx, jti: string): void => {
  db.delete(sessions).where(eq(sessions.jti, jti)).run();
};

export const cleanupExpiredSessions = (db: DbOrTx, now: number): number => {
  const result = db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  return result.changes;
};
