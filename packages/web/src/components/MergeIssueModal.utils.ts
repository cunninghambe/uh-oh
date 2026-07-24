// Pure helpers for MergeIssueModal.tsx (v0.9 CONTRACT — SPEC §24 issue merge), split out for
// unit testing without rendering, same rationale as AnnotationTimeline.utils.ts.

import type { FixAttempt } from '../api.js';

/** The free issue-id field's value with surrounding whitespace stripped — what's actually sent
 * as `into` in `POST /api/issues/:id/merge { into }`. */
export const normalizeIssueId = (value: string): string => value.trim();

/** The free issue-id field's submit button is enabled only once there's something to send — the
 * server is the source of truth on whether that id actually resolves to a mergeable issue (400
 * otherwise, surfaced by the caller via mergeM.isError). */
export const isMergeTargetValid = (value: string): boolean => normalizeIssueId(value).length > 0;

/** True when a similar-issue candidate already has a verified fix — used to give that row a
 * small "verified fix" hint, since a target with a proven fix is usually the better merge choice
 * among several similar issues. */
export const hasVerifiedFix = (fixAttempts: Pick<FixAttempt, 'state'>[]): boolean =>
  fixAttempts.some((fa) => fa.state === 'verified');
