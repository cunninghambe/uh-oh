// Pure helpers for the symbolication status banner, split out from Issue.tsx for unit testing.

import type { ResolvedFrame } from '../api.js';

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
