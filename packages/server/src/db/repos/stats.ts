import { and, eq, gte, sql, type SQL } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { events, issues } from '../schema.js';

export type DayBucket = { date: string; events: number };

const DAY_MS = 86_400_000;

/** Clamp a `days` query param to 1..90, defaulting to 14 for missing/invalid input. */
export const clampDays = (raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 14;
  return Math.max(1, Math.min(90, Math.floor(n)));
};

/** UTC midnight (epoch ms) of the day containing `ms`. */
const utcDayStart = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * Lower bound (epoch ms, inclusive) of the N-UTC-day window ending on the day of
 * `now` — the same window the day-bucket stats use. Shared so top-issues ranks
 * over exactly the stats window.
 */
export const statsWindowLowerMs = (days: number, now: number): number =>
  utcDayStart(now) - (days - 1) * DAY_MS;

/** `YYYY-MM-DD` in UTC for an epoch-ms timestamp. */
const utcDateString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Bucket `received_at` (epoch ms) into a UTC `YYYY-MM-DD` string. Integer
// division by 1000 yields whole seconds for 'unixepoch'.
const dayBucketSql = sql<string>`strftime('%Y-%m-%d', ${events.receivedAt} / 1000, 'unixepoch')`;

const queryDailyCounts = (db: DbOrTx, where: SQL | undefined): Map<string, number> => {
  const rows = db
    .select({ date: dayBucketSql, n: sql<number>`count(*)` })
    .from(events)
    .where(where)
    .groupBy(dayBucketSql)
    .all();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.date, r.n);
  return map;
};

// Build the ascending, zero-filled day series ending on the UTC day of `now`.
const buildDays = (counts: Map<string, number>, days: number, now: number): DayBucket[] => {
  const start = utcDayStart(now) - (days - 1) * DAY_MS;
  const out: DayBucket[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDateString(start + i * DAY_MS);
    out.push({ date, events: counts.get(date) ?? 0 });
  }
  return out;
};

export const projectStats = (
  db: DbOrTx,
  projectId: string,
  days: number,
  now: number = Date.now(),
): { days: DayBucket[]; totalOpenIssues: number } => {
  const lowerMs = utcDayStart(now) - (days - 1) * DAY_MS;
  const counts = queryDailyCounts(
    db,
    and(eq(events.projectId, projectId), gte(events.receivedAt, lowerMs)),
  );
  const totalOpenIssues =
    db
      .select({ n: sql<number>`count(*)` })
      .from(issues)
      .where(and(eq(issues.projectId, projectId), eq(issues.status, 'open')))
      .get()?.n ?? 0;
  return { days: buildDays(counts, days, now), totalOpenIssues };
};

export const issueStats = (
  db: DbOrTx,
  issueId: string,
  days: number,
  now: number = Date.now(),
): { days: DayBucket[] } => {
  const lowerMs = utcDayStart(now) - (days - 1) * DAY_MS;
  const counts = queryDailyCounts(
    db,
    and(eq(events.issueId, issueId), gte(events.receivedAt, lowerMs)),
  );
  return { days: buildDays(counts, days, now) };
};
