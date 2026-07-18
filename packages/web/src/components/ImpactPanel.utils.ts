// Pure helpers for ImpactPanel.tsx (v0.5 CONTRACT I), split out for unit testing without
// rendering.

import type { ImpactSummary } from '../api.js';

export type ImpactListRow = { label: string; events: number };
export type ImpactList = { title: string; rows: ImpactListRow[]; max: number };

/** Bar width as a percentage of the largest count in its own list (each list scales
 * independently — a top release with 900 events shouldn't shrink a top-OS list capped at 12).
 * Floors at 4% so a nonzero count always renders a visible sliver, never a 0px-wide bar. */
export const barPercent = (events: number, max: number): number => {
  if (max <= 0 || events <= 0) return 0;
  return Math.max(4, Math.round((events / max) * 100));
};

/**
 * Builds the renderable top-5 lists from the raw impact payload, skipping any list that's empty
 * (brief: "skip any empty list entirely") and computing each list's own max for bar scaling.
 */
export const impactLists = (impact: ImpactSummary): ImpactList[] => {
  const build = (title: string, rows: ImpactListRow[]): ImpactList | null => {
    if (rows.length === 0) return null;
    const max = Math.max(...rows.map((r) => r.events));
    return { title, rows, max };
  };

  const lists = [
    build(
      'Devices',
      impact.topDevices.map((d) => ({ label: d.model, events: d.events })),
    ),
    build(
      'OS',
      impact.topOs.map((o) => ({ label: o.os, events: o.events })),
    ),
    build(
      'Releases',
      impact.releases.map((r) => ({ label: r.release, events: r.events })),
    ),
    build(
      'Platforms',
      impact.platforms.map((p) => ({ label: p.platform, events: p.events })),
    ),
  ];

  return lists.filter((l): l is ImpactList => l !== null);
};

/** True when there is nothing at all to show — every list empty and no distinct-user stat —
 * so the caller can skip rendering the panel/section entirely rather than an empty shell. */
export const isImpactEmpty = (impact: ImpactSummary): boolean =>
  impact.distinctUsers === null && impactLists(impact).length === 0;
