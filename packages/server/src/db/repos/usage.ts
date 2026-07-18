// CONTRACT U-IN — usage analytics write side: daily visitor-salt lifecycle, the
// visitor hash recipe, and the usage_events insert.
//
// Privacy invariant: the raw client IP and raw User-Agent feed the visitor hash
// and are then discarded. They are NEVER written to a row (or returned/logged by
// anything in this module). The daily salt rotates the hash so the same visitor
// gets a different, uncorrelatable hash on each UTC day.

import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { newId } from '../ids.js';
import { usageEvents, usageSalts, type UsageEventRow } from '../schema.js';

/** UTC day of an epoch-ms timestamp as 'YYYY-MM-DD' (the usage_salts PK / the
 *  day the salt rotates on). */
export const utcDayString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The salt for a given UTC day, creating it lazily (32 crypto-random bytes, hex)
 * on first use. Concurrent creators race harmlessly: onConflictDoNothing keeps
 * the first writer's salt, and we always re-read the stored value so every caller
 * on the same day derives identical hashes.
 *
 * The salt is server-only: it never appears in an API response or a log.
 */
export const getOrCreateDailySalt = (db: DbOrTx, date: string): string => {
  const existing = db.select().from(usageSalts).where(eq(usageSalts.date, date)).get();
  if (existing) return existing.salt;
  const salt = randomBytes(32).toString('hex');
  db.insert(usageSalts).values({ date, salt }).onConflictDoNothing().run();
  return db.select().from(usageSalts).where(eq(usageSalts.date, date)).get()?.salt ?? salt;
};

/**
 * The visitor hash: `sha256(dailySalt | publicKey | clientIp | userAgent)` in
 * hex, truncated to 16 chars. Deterministic within a UTC day; uncorrelatable
 * across days because the salt rotates. The inputs (notably clientIp/userAgent)
 * are used ONLY here and never persisted.
 */
export const computeVisitorHash = (input: {
  salt: string;
  publicKey: string;
  clientIp: string;
  userAgent: string;
}): string =>
  createHash('sha256')
    .update(`${input.salt}|${input.publicKey}|${input.clientIp}|${input.userAgent}`)
    .digest('hex')
    .slice(0, 16);

export const insertUsageEvent = (
  db: DbOrTx,
  input: Omit<UsageEventRow, 'id'> & { id?: string },
): UsageEventRow => {
  const row: UsageEventRow = { ...input, id: input.id ?? newId() };
  db.insert(usageEvents).values(row).run();
  return row;
};
