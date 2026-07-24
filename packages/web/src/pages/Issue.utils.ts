// Pure helpers for the symbolication status banner and the status toggle, split out from
// Issue.tsx for unit testing.

import type { EventRow, Issue, ResolvedFrame } from '../api.js';

const KNOWN_STATUS_LABELS: Partial<Record<ResolvedFrame['status'], string>> = {
  no_symbols: 'no symbols uploaded',
  unsymbolicated: 'unsymbolicated',
  corrupt_mapping: 'corrupt mapping file',
};

/**
 * True if any frame needs attention. Keyed on `!== 'ok'` (not an allowlist of known-bad
 * statuses) so this stays correct if the server adds new non-ok statuses later — e.g. a
 * corrupt-sourcemap status — without requiring a matching change here (M14).
 */
export const hasSymbolIssue = (frames: ResolvedFrame[] | undefined): boolean =>
  frames !== undefined && frames.some((f) => f.status !== 'ok');

/** Human label for a frame status; falls back to the raw status string for anything unknown. */
export const statusLabel = (status: ResolvedFrame['status']): string =>
  KNOWN_STATUS_LABELS[status] ?? status;

export type StatusToggleOption = { value: Issue['status']; label: string };

// v0.3 CONTRACT B: 'regressed' is system-set (a resolved issue recurring), never a direct PATCH
// target — so it never appears as a toggle option. A regressed issue instead offers
// resolve/ignore/reopen (SPEC brief item 2); every other status keeps the pre-existing
// open/resolved/ignored toggle, targeting itself.
//
// v0.9 CONTRACT (SPEC §24 issue merge): 'merged' is likewise system-set (only
// `POST /api/issues/:id/merge` sets it) and PATCH rejects it outright — a merged issue offers no
// toggle at all (empty array), matching how Issue.tsx hides the whole status-toggle row and shows
// the merged-state banner instead.
export const statusToggleOptions = (current: Issue['status']): StatusToggleOption[] => {
  if (current === 'merged') return [];
  return current === 'regressed'
    ? [
        { value: 'resolved', label: 'resolve' },
        { value: 'ignored', label: 'ignore' },
        { value: 'open', label: 'reopen' },
      ]
    : [
        { value: 'open', label: 'open' },
        { value: 'resolved', label: 'resolved' },
        { value: 'ignored', label: 'ignored' },
      ];
};

// v0.4 CONTRACT P: the issue detail header's platform badge prefers the issue's own `platform`
// (server-set from its latest event, but stable even while we're viewing an older event) and
// falls back to the currently-displayed event's platform — which is what the badge showed
// before CONTRACT P existed, and remains correct if an older server omits the field.
export const resolvedPlatform = (
  issue: Pick<Issue, 'platform'>,
  latestEvent: Pick<EventRow, 'platform'> | null,
): EventRow['platform'] | null => issue.platform ?? latestEvent?.platform ?? null;
