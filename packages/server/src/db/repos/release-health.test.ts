// §24 — release health. Deterministic per-release crash roll-up vs. attributed
// usage pageviews, over a day window. Seeded fixtures assert exact rows, the
// null-ratio (no pageviews) case, the ≤20 row cap, and lastEventAt ordering.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { upsertIssue } from './issues.js';
import { upsertRelease } from './releases.js';
import { insertEvent } from './events.js';
import { insertUsageEvent } from './usage.js';
import { clampReleaseHealthDays, releaseHealth } from './release-health.js';
import { buildServer } from '../../server.js';
import { mintTestToken, TEST_SECRET } from '../../auth/test-utils.js';
import type { ProjectRow, IssueRow, ReleaseRow } from '../schema.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const SEC = 1000;

let db: Db;
let close: () => void;
let project: ProjectRow;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});
afterEach(() => close());

const mkIssue = (fp: string): IssueRow =>
  upsertIssue(db, { projectId: project.id, fingerprint: fp, title: `E ${fp}`, ts: NOW }).issue;

const mkRelease = (version: string, build: string, platform: ReleaseRow['platform']): ReleaseRow =>
  upsertRelease(db, { projectId: project.id, version, build, platform });

const seedEvent = (
  release: ReleaseRow,
  issue: IssueRow,
  level: string,
  receivedAt: number,
): void => {
  insertEvent(db, {
    projectId: project.id,
    issueId: issue.id,
    releaseId: release.id,
    fingerprint: issue.fingerprint,
    level,
    platform: release.platform,
    payload: '{}',
    receivedAt,
    deviceInfo: '{}',
    userInfo: null,
  });
};

const seedUsage = (release: string, n: number, type: 'pageview' | 'event' = 'pageview'): void => {
  for (let i = 0; i < n; i++) {
    insertUsageEvent(db, {
      projectId: project.id,
      type,
      name: type === 'event' ? 'ev' : null,
      path: type === 'pageview' ? '/' : null,
      referrerDomain: null,
      visitor: `${release}-${String(i)}`,
      props: null,
      release,
      receivedAt: NOW - SEC,
    });
  }
};

describe('releaseHealth — deterministic multi-release fixtures', () => {
  const seedFleet = () => {
    const i1 = mkIssue('fp1');
    const i2 = mkIssue('fp2');
    const rA = mkRelease('1.0.0', '1', 'web');
    const rB = mkRelease('2.0.0', '1', 'web');
    const rC = mkRelease('3.0.0', '1', 'ios');
    mkRelease('4.0.0', '1', 'web'); // no events → excluded

    // A: 3 in-window events (2 fatal) across 2 issues; 1 event outside the window.
    seedEvent(rA, i1, 'fatal', NOW - 5 * SEC);
    seedEvent(rA, i1, 'fatal', NOW - 4 * SEC);
    seedEvent(rA, i2, 'error', NOW - 3 * SEC);
    seedEvent(rA, i1, 'fatal', NOW - 40 * DAY); // out of the 30-day window
    // B: 1 event (no fatals), 1 issue.
    seedEvent(rB, i1, 'error', NOW - 1 * SEC);
    // C: 2 events (1 fatal), 1 issue.
    seedEvent(rC, i2, 'fatal', NOW - 2 * SEC);
    seedEvent(rC, i2, 'error', NOW - 1500);

    // Attribution is by CANONICAL version+build (CONTRACT RH-STAMP): the js
    // client stamps "1.0.0+1", never the bare version.
    seedUsage('1.0.0+1', 10); // A: 3/10*1000 = 300.0
    seedUsage('2.0.0+1', 3); // B: 1/3*1000 = 333.3
    seedUsage('1.0.0+1', 2, 'event'); // custom events are NOT pageviews → ignored
    seedUsage('9.9.9+1', 5); // unmatched release → attributed to nothing
    seedUsage('2.0.0', 2); // bare version (no +build) does NOT attribute — canonical only
    seedUsage('4.0.0+1', 4); // release has no events → not in the output at all
  };

  it('produces the exact rows, ordered by lastEventAt desc, with correct ratios', () => {
    seedFleet();
    const health = releaseHealth(db, project.id, 30, NOW);

    expect(health.releases).toHaveLength(3);
    // Ordered by most-recent event: B (‑1s) > C (‑1.5s) > A (‑3s).
    expect(health.releases.map((r) => r.version)).toEqual(['2.0.0', '3.0.0', '1.0.0']);

    expect(health.releases[0]).toMatchObject({
      version: '2.0.0',
      build: '1',
      platform: 'web',
      events: 1,
      fatalEvents: 0,
      distinctIssues: 1,
      firstEventAt: NOW - 1 * SEC,
      lastEventAt: NOW - 1 * SEC,
      pageviews: 3,
      crashesPer1kPageviews: 333.3,
    });
    expect(health.releases[1]).toMatchObject({
      version: '3.0.0',
      platform: 'ios',
      events: 2,
      fatalEvents: 1,
      distinctIssues: 1,
      firstEventAt: NOW - 2 * SEC,
      lastEventAt: NOW - 1500,
      pageviews: 0,
      crashesPer1kPageviews: null, // no pageviews (non-web) → null ratio
    });
    expect(health.releases[2]).toMatchObject({
      version: '1.0.0',
      events: 3, // the 40-day-old event is windowed out
      fatalEvents: 2,
      distinctIssues: 2,
      firstEventAt: NOW - 5 * SEC,
      lastEventAt: NOW - 3 * SEC,
      pageviews: 10,
      crashesPer1kPageviews: 300,
    });

    // Project-wide totals over the window: every event and every pageview
    // (attributed or not — 10+3+5+2+4), mirroring the table's five columns.
    expect(health.totals).toEqual({
      events: 6,
      fatalEvents: 3,
      distinctIssues: 2,
      pageviews: 24,
      crashesPer1kPageviews: 250,
    });
  });

  it('is deterministic — identical output across repeated calls', () => {
    seedFleet();
    const a = releaseHealth(db, project.id, 30, NOW);
    const b = releaseHealth(db, project.id, 30, NOW);
    expect(a).toEqual(b);
  });

  it('caps the release list at 20, keeping the newest by lastEventAt', () => {
    const issue = mkIssue('fp');
    for (let k = 0; k < 25; k++) {
      const r = mkRelease(`v${String(k)}`, '1', 'web');
      // k=0 is the most recent; k=24 the oldest.
      seedEvent(r, issue, 'error', NOW - k * SEC);
    }
    const health = releaseHealth(db, project.id, 30, NOW);
    expect(health.releases).toHaveLength(20);
    // The newest (smallest offset) survives; the 5 oldest are dropped.
    expect(health.releases[0]?.version).toBe('v0');
    expect(health.releases[19]?.version).toBe('v19');
  });
});

describe('clampReleaseHealthDays', () => {
  it('defaults to 30 and clamps to 1..90', () => {
    expect(clampReleaseHealthDays(undefined)).toBe(30);
    expect(clampReleaseHealthDays('not-a-number')).toBe(30);
    expect(clampReleaseHealthDays('0')).toBe(1);
    expect(clampReleaseHealthDays('1000')).toBe(90);
    expect(clampReleaseHealthDays('7')).toBe(7);
  });
});

describe('GET /api/projects/:id/release-health', () => {
  const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });

  it('requires auth', async () => {
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/release-health`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s on an unknown project', async () => {
    const token = await mintTestToken(db);
    const res = await app().inject({
      method: 'GET',
      url: '/api/projects/nope/release-health',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns { releases, totals } under a JWT', async () => {
    const token = await mintTestToken(db);
    const issue = mkIssue('fp');
    const r = mkRelease('1.0.0', '1', 'web');
    seedEvent(r, issue, 'fatal', Date.now());
    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/release-health?days=7`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ releases: unknown[]; totals: Record<string, number> }>();
    expect(Array.isArray(body.releases)).toBe(true);
    expect(body.releases).toHaveLength(1);
    expect(body.totals).toEqual({
      events: 1,
      fatalEvents: 1,
      distinctIssues: 1,
      pageviews: 0,
      crashesPer1kPageviews: null,
    });
  });
});
