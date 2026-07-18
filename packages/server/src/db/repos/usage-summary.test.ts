import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../index.js';
import { makeTestDb } from '../test-utils.js';
import { createProject } from './projects.js';
import { insertUsageEvent } from './usage.js';
import { clampUsageDays, usageSummary } from './usage-summary.js';
import type { ProjectRow } from '../schema.js';

let db: Db;
let close: () => void;
let project: ProjectRow;

const NOW = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18T12:00:00Z
const DAY_MS = 86_400_000;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
});
afterEach(() => close());

const add = (input: {
  type: 'pageview' | 'event';
  path?: string | null;
  name?: string | null;
  referrerDomain?: string | null;
  visitor: string;
  at?: number;
}) =>
  insertUsageEvent(db, {
    projectId: project.id,
    type: input.type,
    name: input.name ?? null,
    path: input.path ?? null,
    referrerDomain: input.referrerDomain ?? null,
    visitor: input.visitor,
    props: null,
    receivedAt: input.at ?? NOW,
  });

describe('clampUsageDays', () => {
  it('defaults to 30 and clamps to 1..90', () => {
    expect(clampUsageDays(undefined)).toBe(30);
    expect(clampUsageDays('abc')).toBe(30);
    expect(clampUsageDays('7')).toBe(7);
    expect(clampUsageDays('0')).toBe(1);
    expect(clampUsageDays('1000')).toBe(90);
  });
});

describe('usageSummary', () => {
  it('returns an ascending, zero-filled day series ending on the UTC day of now', () => {
    add({ type: 'pageview', path: '/a', visitor: 'v1' });
    const s = usageSummary(db, project.id, 7, NOW);
    expect(s.days).toHaveLength(7);
    expect(s.days[0]?.date).toBe('2026-07-12');
    expect(s.days[6]?.date).toBe('2026-07-18');
    expect(s.days[6]?.pageviews).toBe(1);
    expect(s.days[0]?.pageviews).toBe(0);
  });

  it('counts pageviews, events, and distinct visitors per day and in totals', () => {
    // Today: 2 pageviews (v1, v2), 1 event (v1) => visitors distinct = 2.
    add({ type: 'pageview', path: '/a', visitor: 'v1' });
    add({ type: 'pageview', path: '/a', visitor: 'v2' });
    add({ type: 'event', name: 'signup', visitor: 'v1' });
    const s = usageSummary(db, project.id, 7, NOW);
    const today = s.days[6];
    expect(today).toMatchObject({ pageviews: 2, events: 1, visitors: 2 });
    expect(s.totals).toEqual({ pageviews: 2, visitors: 2, events: 1 });
  });

  it('ranks top pages by pageviews desc then path asc, with distinct visitors', () => {
    add({ type: 'pageview', path: '/home', visitor: 'v1' });
    add({ type: 'pageview', path: '/home', visitor: 'v2' });
    add({ type: 'pageview', path: '/about', visitor: 'v1' });
    const s = usageSummary(db, project.id, 30, NOW);
    expect(s.topPages).toEqual([
      { path: '/home', pageviews: 2, visitors: 2 },
      { path: '/about', pageviews: 1, visitors: 1 },
    ]);
  });

  it('ranks top referrers and EXCLUDES the null (direct) bucket', () => {
    add({ type: 'pageview', path: '/', referrerDomain: 'google.com', visitor: 'v1' });
    add({ type: 'pageview', path: '/', referrerDomain: 'google.com', visitor: 'v2' });
    add({ type: 'pageview', path: '/', referrerDomain: 'news.example.com', visitor: 'v1' });
    add({ type: 'pageview', path: '/', referrerDomain: null, visitor: 'v3' }); // direct
    const s = usageSummary(db, project.id, 30, NOW);
    expect(s.topReferrers).toEqual([
      { referrer: 'google.com', pageviews: 2 },
      { referrer: 'news.example.com', pageviews: 1 },
    ]);
  });

  it('ranks top events by count desc then name asc', () => {
    add({ type: 'event', name: 'click', visitor: 'v1' });
    add({ type: 'event', name: 'click', visitor: 'v2' });
    add({ type: 'event', name: 'signup', visitor: 'v1' });
    const s = usageSummary(db, project.id, 30, NOW);
    expect(s.topEvents).toEqual([
      { name: 'click', count: 2 },
      { name: 'signup', count: 1 },
    ]);
  });

  it('excludes rows outside the window and other projects', () => {
    const other = createProject(db, { name: 'Other' });
    insertUsageEvent(db, {
      projectId: other.id,
      type: 'pageview',
      name: null,
      path: '/x',
      referrerDomain: null,
      visitor: 'z',
      props: null,
      receivedAt: NOW,
    });
    add({ type: 'pageview', path: '/old', visitor: 'v1', at: NOW - 40 * DAY_MS }); // before 30-day window
    add({ type: 'pageview', path: '/in', visitor: 'v1' });
    const s = usageSummary(db, project.id, 30, NOW);
    expect(s.totals.pageviews).toBe(1);
    expect(s.topPages).toEqual([{ path: '/in', pageviews: 1, visitors: 1 }]);
  });

  it('over-counts a repeat cross-day visitor (documented privacy trade)', () => {
    // Same logical visitor but the hash rotated between days -> two distinct
    // hashes -> counted as 2 across the window (intentional privacy over-count).
    add({ type: 'pageview', path: '/', visitor: 'day1hash00000000', at: NOW - DAY_MS });
    add({ type: 'pageview', path: '/', visitor: 'day2hash00000000', at: NOW });
    const s = usageSummary(db, project.id, 30, NOW);
    expect(s.totals.visitors).toBe(2);
  });
});
