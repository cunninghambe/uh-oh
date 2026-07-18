// Pure helpers for the symbol upload zone, split out from Releases.tsx for unit testing
// without needing DOM drag events.

import { MAX_SYMBOL_UPLOAD_BYTES, type ReleaseSymbolMap } from '../api.js';

export const formatMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Returns a friendly error message if the file exceeds the server's upload cap, else null. */
export const oversizeError = (fileSize: number): string | null =>
  fileSize > MAX_SYMBOL_UPLOAD_BYTES
    ? `File is ${formatMb(fileSize)} — the server limit is ${formatMb(MAX_SYMBOL_UPLOAD_BYTES)}.`
    : null;

// v0.4 item 2: per-release "N web maps · M node maps" summary, from GET
// /api/releases/:id/symbols. Split out for unit testing, same rationale as the rest of this file.

/**
 * Release rows fetch their map counts eagerly on mount when the whole releases list is this
 * size or smaller (one request per row, but never more than this many at once). Longer lists
 * fetch lazily — on hover/focus of a row — so opening a project with hundreds of releases
 * doesn't fan out hundreds of parallel requests. See Releases.tsx's ReleaseMapsCount.
 */
export const EAGER_MAP_COUNT_THRESHOLD = 10;

export type MapCounts = { web: number; node: number };

export const summarizeMapCounts = (maps: Pick<ReleaseSymbolMap, 'platform'>[]): MapCounts => {
  const counts: MapCounts = { web: 0, node: 0 };
  for (const m of maps) {
    counts[m.platform] += 1;
  }
  return counts;
};

/** e.g. "12 web maps · 8 node maps"; a platform with zero maps is omitted; '' when both are 0. */
export const formatMapCounts = (counts: MapCounts): string =>
  (
    [
      [counts.web, 'web'],
      [counts.node, 'node'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${String(n)} ${label} map${n === 1 ? '' : 's'}`)
    .join(' · ');
