// Release health (v0.9 §24). A deterministic roll-up, per release, of its crash
// volume over a day window against the usage pageviews attributed to it —
// `crashesPer1kPageviews` being the headline ratio. Every number is a windowed
// aggregate over the (issue/project, received_at) indexes; pageviews are matched
// to a release by the client-stamped `usage_events.release` string equalling the
// CANONICAL release identity version+'+'+build (the js client stamps exactly
// that - CONTRACT RH-STAMP in uh-oh-client.ts - so "1.2.3+47" matches the row
// created by the crash envelope, and a buildless init release matches as
// "1.2.3+0"). Ratios are null when a release has no attributed pageviews
// (analytics off, non-web, or unattributed), so the SQL never divides by zero.

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';

const DAY_MS = 86_400_000;
/** Max releases returned, ordered by most-recent event. */
const MAX_RELEASES = 20;

export interface ReleaseHealthEntry {
  id: string;
  version: string;
  build: string;
  platform: string;
  commitSha: string | null;
  events: number;
  fatalEvents: number;
  distinctIssues: number;
  firstEventAt: number;
  lastEventAt: number;
  pageviews: number;
  /** events / pageviews × 1000, 1 decimal; null when pageviews is 0. */
  crashesPer1kPageviews: number | null;
}

export interface ReleaseHealth {
  releases: ReleaseHealthEntry[];
  /**
   * Project-wide over the same window: every event (attributed or not), every
   * usage pageview (any release, none included), and the ratio of the two —
   * mirroring the five numeric columns of the per-release table.
   */
  totals: {
    events: number;
    fatalEvents: number;
    distinctIssues: number;
    pageviews: number;
    crashesPer1kPageviews: number | null;
  };
}

/** Clamp a `days` query param to 1..90, defaulting to 30 for missing/invalid. */
export const clampReleaseHealthDays = (raw: unknown): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, Math.floor(n)));
};

/** events/pageviews × 1000, rounded to 1 decimal; null when there are no pageviews. */
const ratioPer1k = (events: number, pageviews: number): number | null =>
  pageviews > 0 ? Math.round((events / pageviews) * 1000 * 10) / 10 : null;

type Row = {
  id: string;
  version: string;
  build: string;
  platform: string;
  commitSha: string | null;
  events: number;
  fatalEvents: number;
  distinctIssues: number;
  firstEventAt: number;
  lastEventAt: number;
  pageviews: number;
};

export const releaseHealth = (
  db: DbOrTx,
  projectId: string,
  days: number,
  now: number = Date.now(),
): ReleaseHealth => {
  const lower = now - days * DAY_MS;

  // Every release with ≥1 event in the window, its crash aggregates, and the
  // pageviews attributed to it by canonical version+build identity. INNER JOIN
  // drops releases with no windowed events; ORDER + LIMIT keep the newest ≤20.
  const rows = db.all<Row>(sql`
    SELECT
      r.id AS id,
      r.version AS version,
      r.build AS build,
      r.platform AS platform,
      r.commit_sha AS commitSha,
      COUNT(e.id) AS events,
      SUM(CASE WHEN e.level = 'fatal' THEN 1 ELSE 0 END) AS fatalEvents,
      COUNT(DISTINCT e.issue_id) AS distinctIssues,
      MIN(e.received_at) AS firstEventAt,
      MAX(e.received_at) AS lastEventAt,
      (SELECT COUNT(*) FROM usage_events u
        WHERE u.project_id = r.project_id
          AND u.type = 'pageview'
          AND u.release = r.version || '+' || r.build
          AND u.received_at >= ${lower}) AS pageviews
    FROM releases r
    JOIN events e ON e.release_id = r.id AND e.received_at >= ${lower}
    WHERE r.project_id = ${projectId}
    GROUP BY r.id
    ORDER BY lastEventAt DESC, r.id ASC
    LIMIT ${MAX_RELEASES}
  `);

  const releases: ReleaseHealthEntry[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    build: r.build,
    platform: r.platform,
    commitSha: r.commitSha,
    events: r.events,
    fatalEvents: r.fatalEvents,
    distinctIssues: r.distinctIssues,
    firstEventAt: r.firstEventAt,
    lastEventAt: r.lastEventAt,
    pageviews: r.pageviews,
    crashesPer1kPageviews: ratioPer1k(r.events, r.pageviews),
  }));

  // Project-wide totals over the same window (all events, including those with no
  // release attribution; all pageviews, attributed or not) — the same five
  // numeric columns the per-release table shows.
  const totalsRow = db.get<{ events: number; fatalEvents: number; distinctIssues: number }>(sql`
    SELECT
      COUNT(*) AS events,
      SUM(CASE WHEN level = 'fatal' THEN 1 ELSE 0 END) AS fatalEvents,
      COUNT(DISTINCT issue_id) AS distinctIssues
    FROM events
    WHERE project_id = ${projectId} AND received_at >= ${lower}
  `);
  const totalPageviewsRow = db.get<{ pageviews: number }>(sql`
    SELECT COUNT(*) AS pageviews
    FROM usage_events
    WHERE project_id = ${projectId} AND type = 'pageview' AND received_at >= ${lower}
  `);

  const totalEvents = totalsRow?.events ?? 0;
  const totalPageviews = totalPageviewsRow?.pageviews ?? 0;
  return {
    releases,
    totals: {
      events: totalEvents,
      fatalEvents: totalsRow?.fatalEvents ?? 0,
      distinctIssues: totalsRow?.distinctIssues ?? 0,
      pageviews: totalPageviews,
      crashesPer1kPageviews: ratioPer1k(totalEvents, totalPageviews),
    },
  };
};
