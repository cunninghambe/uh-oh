// Pure helpers for ReleaseHealthSection.tsx (v0.9 CONTRACT — SPEC §24 release health), split out
// for unit testing without rendering, same rationale as UsageSection.utils.ts.

/** The days-selector's three supported windows — same 7/30/90 pattern as UsageSection.utils.ts's
 * USAGE_DAY_OPTIONS (brief: "a days toggle consistent with the Usage section's 7/30/90
 * pattern"), deliberately a separate copy rather than a shared import so each section's toggle
 * stays independently testable/tunable, matching how the two sections already don't share state. */
export const RELEASE_HEALTH_DAY_OPTIONS = [7, 30, 90] as const;
export type ReleaseHealthDaysOption = (typeof RELEASE_HEALTH_DAY_OPTIONS)[number];
export const DEFAULT_RELEASE_HEALTH_DAYS: ReleaseHealthDaysOption = 30;

export const isReleaseHealthDaysOption = (value: number): value is ReleaseHealthDaysOption =>
  (RELEASE_HEALTH_DAY_OPTIONS as readonly number[]).includes(value);

export type RatioBadgeStyle = { label: string; className: string };

// SPEC §24: crashesPer1kPageviews is null when pageviews is 0 (analytics off, non-web, or
// unattributed) — rendered as a neutral dash, never "0". Below that, a simple traffic-light
// judgment call (not specced numerically): 0 is the "good" emerald, a low-but-nonzero rate is
// amber, and a high rate is red — mirroring the semantic colors MonitorsSection.utils.ts's
// STATUS_PILL and FixAttemptsPanel.utils.ts's STATE_PILL already use (emerald=healthy,
// amber=open/watch, red=bad).
const RATIO_WARN_THRESHOLD = 5;
const RATIO_BAD_THRESHOLD = 20;

export const formatRatio = (ratio: number | null): string => (ratio === null ? '—' : String(ratio));

export const crashRatioBadgeStyle = (ratio: number | null): RatioBadgeStyle => {
  const label = formatRatio(ratio);
  if (ratio === null) {
    return { label, className: 'border-zinc-700 bg-zinc-900 text-zinc-500' };
  }
  if (ratio === 0) {
    return { label, className: 'border-emerald-600 bg-emerald-950 text-emerald-300' };
  }
  if (ratio <= RATIO_WARN_THRESHOLD) {
    return { label, className: 'border-amber-600 bg-amber-950 text-amber-300' };
  }
  if (ratio <= RATIO_BAD_THRESHOLD) {
    return { label, className: 'border-orange-600 bg-orange-950 text-orange-300' };
  }
  return { label, className: 'border-red-600 bg-red-950 text-red-300' };
};

/** "1.2.3+45" — the version+build display used by the releases table (Releases.tsx uses the same
 * "version+build" shape inline; split out here since ReleaseHealthSection.tsx needs it twice, for
 * the table rows and nowhere else, but a named helper documents the format and stays testable). */
export const releaseLabel = (version: string, build: string): string => `${version}+${build}`;
