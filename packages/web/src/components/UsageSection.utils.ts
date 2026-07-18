// Pure helpers for UsageSection.tsx (v0.6 CONTRACT U-API), split out for unit testing without
// rendering.

import type { UsageSummary } from '../api.js';

/** The days-selector's three supported windows (brief: "Days selector: 7 / 30 / 90 toggle"). */
export const USAGE_DAY_OPTIONS = [7, 30, 90] as const;
export type UsageDaysOption = (typeof USAGE_DAY_OPTIONS)[number];
export const DEFAULT_USAGE_DAYS: UsageDaysOption = 30;

export const isUsageDaysOption = (value: number): value is UsageDaysOption =>
  (USAGE_DAY_OPTIONS as readonly number[]).includes(value);

/** Shared copy for both empty-state spots (brief: trend-chart zero-data hint and the top-lists
 * "ALL lists empty" fallback are "the empty-state hint", singular — see UsageSection.tsx, where
 * a single `lists.length > 0` check covers both: a summary with zero totals can never produce a
 * populated top-list, so one hint slot right after the chart naturally satisfies both bullets). */
export const USAGE_EMPTY_HINT =
  'No usage recorded yet — data appears once pages send events via the @uh-oh/js analytics option.';

export type UsageBarRow = { label: string; primary: number; secondary?: number | undefined };
export type UsageBarList = { title: string; rows: UsageBarRow[]; max: number };

/**
 * Builds the renderable top-3 lists (pages/referrers/events) from the raw usage summary,
 * skipping any list that's empty (brief: "empty lists show nothing") and computing each list's
 * own max for bar scaling — same shape/behavior as ImpactPanel.utils.ts's `impactLists`, whose
 * `barPercent` this module's caller (UsageSection.tsx) reuses directly for the bar widths
 * ("same visual language as the Impact panel").
 */
export const usageBarLists = (summary: UsageSummary): UsageBarList[] => {
  const build = (title: string, rows: UsageBarRow[]): UsageBarList | null => {
    if (rows.length === 0) return null;
    const max = Math.max(...rows.map((r) => r.primary));
    return { title, rows, max };
  };

  const lists = [
    build(
      'Top pages',
      summary.topPages.map((p) => ({ label: p.path, primary: p.pageviews, secondary: p.visitors })),
    ),
    build(
      'Top referrers',
      summary.topReferrers.map((r) => ({ label: r.referrer, primary: r.pageviews })),
    ),
    build(
      'Top events',
      summary.topEvents.map((e) => ({ label: e.name, primary: e.count })),
    ),
  ];

  return lists.filter((l): l is UsageBarList => l !== null);
};
