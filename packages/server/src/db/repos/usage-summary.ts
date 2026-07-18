// CONTRACT U-API — usage analytics read side. Indexed, grouped SQL over
// usage_events for the summary endpoint (and the get_usage_summary MCP tool via
// the in-process backend). All aggregation happens in SQLite; nothing here reads
// or exposes raw IP / User-Agent (those were never stored).

import { and, asc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';
import { usageEvents } from '../schema.js';

const DAY_MS = 86_400_000;

export interface UsageDay {
  date: string;
  pageviews: number;
  visitors: number;
  events: number;
}

export interface UsageSummary {
  /** Ascending, zero-filled day series ending on the UTC day of `now`. */
  days: UsageDay[];
  topPages: Array<{ path: string; pageviews: number; visitors: number }>;
  /** Domain strings only; the null-referrer ("direct") bucket is excluded. */
  topReferrers: Array<{ referrer: string; pageviews: number }>;
  topEvents: Array<{ name: string; count: number }>;
  totals: { pageviews: number; visitors: number; events: number };
}

/** Clamp a `days` query param to 1..90, defaulting to 30 for missing/invalid. */
export const clampUsageDays = (raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, Math.floor(n)));
};

/** UTC midnight (epoch ms) of the day containing `ms`. */
const utcDayStart = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** `YYYY-MM-DD` in UTC for an epoch-ms timestamp. */
const utcDateString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// Bucket received_at (epoch ms) into a UTC `YYYY-MM-DD` string. Integer division
// by 1000 yields whole seconds for 'unixepoch'.
const dayBucket = sql<string>`strftime('%Y-%m-%d', ${usageEvents.receivedAt} / 1000, 'unixepoch')`;
const countStar = sql<number>`count(*)`;
const distinctVisitors = sql<number>`count(distinct ${usageEvents.visitor})`;
const pageviewSum = sql<number>`sum(case when ${usageEvents.type} = 'pageview' then 1 else 0 end)`;
const eventSum = sql<number>`sum(case when ${usageEvents.type} = 'event' then 1 else 0 end)`;

export const usageSummary = (
  db: DbOrTx,
  projectId: string,
  days: number,
  now: number = Date.now(),
): UsageSummary => {
  const lowerMs = utcDayStart(now) - (days - 1) * DAY_MS;
  const inWindow = and(eq(usageEvents.projectId, projectId), gte(usageEvents.receivedAt, lowerMs));

  // Per-day pageviews / events / distinct visitors, in one grouped scan.
  //
  // Privacy trade (documented per contract): `visitors` is a distinct count of
  // the daily-rotating visitor hash. Because the hash rotates each UTC day, a
  // visitor returning across days is counted once PER day — cross-day distinct
  // over rotating hashes intentionally over-counts repeat visitors. That is the
  // privacy cost of making the hash uncorrelatable across days.
  const perDayRows = db
    .select({
      date: dayBucket,
      pageviews: pageviewSum,
      events: eventSum,
      visitors: distinctVisitors,
    })
    .from(usageEvents)
    .where(inWindow)
    .groupBy(dayBucket)
    .all();
  const perDay = new Map(perDayRows.map((r) => [r.date, r]));

  const start = utcDayStart(now) - (days - 1) * DAY_MS;
  const daysOut: UsageDay[] = [];
  for (let i = 0; i < days; i++) {
    const date = utcDateString(start + i * DAY_MS);
    const r = perDay.get(date);
    daysOut.push({
      date,
      pageviews: r?.pageviews ?? 0,
      visitors: r?.visitors ?? 0,
      events: r?.events ?? 0,
    });
  }

  const topPages = db
    .select({ path: usageEvents.path, pageviews: countStar, visitors: distinctVisitors })
    .from(usageEvents)
    .where(and(inWindow, eq(usageEvents.type, 'pageview'), isNotNull(usageEvents.path)))
    .groupBy(usageEvents.path)
    .orderBy(sql`count(*) desc`, asc(usageEvents.path))
    .limit(10)
    .all()
    .map((r) => ({ path: r.path ?? '', pageviews: r.pageviews, visitors: r.visitors }));

  const topReferrers = db
    .select({ referrer: usageEvents.referrerDomain, pageviews: countStar })
    .from(usageEvents)
    .where(and(inWindow, eq(usageEvents.type, 'pageview'), isNotNull(usageEvents.referrerDomain)))
    .groupBy(usageEvents.referrerDomain)
    .orderBy(sql`count(*) desc`, asc(usageEvents.referrerDomain))
    .limit(10)
    .all()
    .map((r) => ({ referrer: r.referrer ?? '', pageviews: r.pageviews }));

  const topEvents = db
    .select({ name: usageEvents.name, count: countStar })
    .from(usageEvents)
    .where(and(inWindow, eq(usageEvents.type, 'event'), isNotNull(usageEvents.name)))
    .groupBy(usageEvents.name)
    .orderBy(sql`count(*) desc`, asc(usageEvents.name))
    .limit(10)
    .all()
    .map((r) => ({ name: r.name ?? '', count: r.count }));

  const totalsRow = db
    .select({ pageviews: pageviewSum, events: eventSum, visitors: distinctVisitors })
    .from(usageEvents)
    .where(inWindow)
    .get();

  return {
    days: daysOut,
    topPages,
    topReferrers,
    topEvents,
    totals: {
      pageviews: totalsRow?.pageviews ?? 0,
      visitors: totalsRow?.visitors ?? 0,
      events: totalsRow?.events ?? 0,
    },
  };
};
