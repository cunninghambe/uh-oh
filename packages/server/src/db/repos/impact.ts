// CONTRACT I — issue impact. A compact, deterministic roll-up of who/what an
// issue is hitting: distinct users, and the top devices / OS / releases /
// platforms by event volume. Every aggregate is a GROUP BY over the issue's
// events (scoped by the (issue_id, received_at) index), pulling device / user /
// release fields out of the stored JSON with SQLite's JSON1 `json_extract`.
//
// Ordering is deterministic: volume DESC, then the label ASC so ties never
// depend on row order. Lists are capped so the payload stays bounded.

import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../index.js';

export type ImpactBucket<K extends string> = { events: number } & Record<K, string>;

export type IssueImpact = {
  /** Distinct user ids across the issue's events, or null when none carry a user. */
  distinctUsers: number | null;
  topDevices: Array<{ model: string; events: number }>;
  topOs: Array<{ os: string; events: number }>;
  releases: Array<{ release: string; events: number }>;
  platforms: Array<{ platform: string; events: number }>;
};

// Cap on device / os / release lists (platforms is naturally ≤4).
const TOP_N = 5;

export const computeImpact = (db: DbOrTx, issueId: string): IssueImpact => {
  const distinctRow = db.get<{ n: number }>(sql`
    SELECT COUNT(DISTINCT json_extract(user_info, '$.id')) AS n
    FROM events
    WHERE issue_id = ${issueId} AND user_info IS NOT NULL
  `);
  const distinctUsers = distinctRow && distinctRow.n > 0 ? distinctRow.n : null;

  const topDevices = db.all<{ model: string; events: number }>(sql`
    SELECT json_extract(device_info, '$.deviceModel') AS model, COUNT(*) AS events
    FROM events
    WHERE issue_id = ${issueId} AND json_extract(device_info, '$.deviceModel') IS NOT NULL
    GROUP BY model
    ORDER BY events DESC, model ASC
    LIMIT ${TOP_N}
  `);

  const topOs = db.all<{ os: string; events: number }>(sql`
    SELECT
      json_extract(device_info, '$.osName') || ' ' || json_extract(device_info, '$.osVersion') AS os,
      COUNT(*) AS events
    FROM events
    WHERE issue_id = ${issueId}
      AND json_extract(device_info, '$.osName') IS NOT NULL
      AND json_extract(device_info, '$.osVersion') IS NOT NULL
    GROUP BY os
    ORDER BY events DESC, os ASC
    LIMIT ${TOP_N}
  `);

  const releases = db.all<{ release: string; events: number }>(sql`
    SELECT
      json_extract(payload, '$.release.version') || '+' || json_extract(payload, '$.release.build') AS release,
      COUNT(*) AS events
    FROM events
    WHERE issue_id = ${issueId}
      AND json_extract(payload, '$.release.version') IS NOT NULL
      AND json_extract(payload, '$.release.build') IS NOT NULL
    GROUP BY release
    ORDER BY events DESC, release ASC
    LIMIT ${TOP_N}
  `);

  const platforms = db.all<{ platform: string; events: number }>(sql`
    SELECT platform, COUNT(*) AS events
    FROM events
    WHERE issue_id = ${issueId}
    GROUP BY platform
    ORDER BY events DESC, platform ASC
  `);

  return { distinctUsers, topDevices, topOs, releases, platforms };
};
