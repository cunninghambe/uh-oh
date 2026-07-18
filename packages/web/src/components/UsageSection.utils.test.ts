import { describe, expect, it } from 'vitest';

import type { UsageSummary } from '../api.js';
import { isUsageDaysOption, usageBarLists } from './UsageSection.utils.js';

const empty: UsageSummary = {
  days: [],
  topPages: [],
  topReferrers: [],
  topEvents: [],
  totals: { pageviews: 0, visitors: 0, events: 0 },
};

describe('isUsageDaysOption', () => {
  it('accepts exactly 7, 30, 90', () => {
    expect(isUsageDaysOption(7)).toBe(true);
    expect(isUsageDaysOption(30)).toBe(true);
    expect(isUsageDaysOption(90)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isUsageDaysOption(14)).toBe(false);
    expect(isUsageDaysOption(1)).toBe(false);
    expect(isUsageDaysOption(0)).toBe(false);
    expect(isUsageDaysOption(-30)).toBe(false);
  });
});

describe('usageBarLists', () => {
  it('is empty when every list in the summary is empty', () => {
    expect(usageBarLists(empty)).toEqual([]);
  });

  it('skips any individually-empty list, keeping only populated ones', () => {
    const lists = usageBarLists({
      ...empty,
      topPages: [{ path: '/docs', pageviews: 10, visitors: 4 }],
    });
    expect(lists.map((l) => l.title)).toEqual(['Top pages']);
  });

  it('carries pageviews as the primary bar value and visitors as a secondary number for pages', () => {
    const [pages] = usageBarLists({
      ...empty,
      topPages: [{ path: '/docs', pageviews: 10, visitors: 4 }],
    });
    expect(pages?.rows[0]).toEqual({ label: '/docs', primary: 10, secondary: 4 });
    expect(pages?.max).toBe(10);
  });

  it('has no secondary value for referrers (pageviews only)', () => {
    const [referrers] = usageBarLists({
      ...empty,
      topReferrers: [{ referrer: 'google.com', pageviews: 7 }],
    });
    expect(referrers?.rows[0]).toEqual({ label: 'google.com', primary: 7 });
    expect(referrers?.rows[0]?.secondary).toBeUndefined();
  });

  it('uses count as the primary bar value for events', () => {
    const [events] = usageBarLists({
      ...empty,
      topEvents: [{ name: 'signup_clicked', count: 3 }],
    });
    expect(events?.rows[0]).toEqual({ label: 'signup_clicked', primary: 3 });
  });

  it('computes each list’s own max independently from a large pages count', () => {
    const lists = usageBarLists({
      ...empty,
      topPages: [{ path: '/docs', pageviews: 900, visitors: 400 }],
      topEvents: [{ name: 'signup_clicked', count: 3 }],
    });
    const pages = lists.find((l) => l.title === 'Top pages');
    const events = lists.find((l) => l.title === 'Top events');
    expect(pages?.max).toBe(900);
    expect(events?.max).toBe(3);
  });

  it('preserves server-provided ordering (by pageviews/count desc — a server concern, not recomputed here)', () => {
    const [pages] = usageBarLists({
      ...empty,
      topPages: [
        { path: '/a', pageviews: 20, visitors: 5 },
        { path: '/b', pageviews: 5, visitors: 2 },
      ],
    });
    expect(pages?.rows.map((r) => r.label)).toEqual(['/a', '/b']);
  });
});
