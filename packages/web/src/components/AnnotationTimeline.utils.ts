// Pure helpers for AnnotationTimeline.tsx (v0.8 CONTRACT — SPEC §23 annotations), split out for
// unit testing without rendering, same rationale as MonitorsSection.utils.ts.

import type { IssueAnnotation } from '../api.js';

export const ANNOTATIONS_PAGE_SIZE = 10;

export type KindBadgeStyle = { label: string; className: string };

// Distinct per-kind coloring so the timeline reads at a glance: 'system' (server-written audit
// rows on fix-attempt transitions) is deliberately the quietest/dashed, matching how it's the one
// kind nobody types by hand. Record<IssueAnnotation['kind'], …> keeps this exhaustive — a new
// kind added to the union fails to typecheck here until handled, same pattern as MonitorsSection's
// STATUS_PILL.
const KIND_BADGE: Record<IssueAnnotation['kind'], KindBadgeStyle> = {
  note: { label: 'note', className: 'border-zinc-700 bg-zinc-900 text-zinc-400' },
  root_cause: { label: 'root cause', className: 'border-amber-600 bg-amber-950 text-amber-300' },
  fix_plan: { label: 'fix plan', className: 'border-sky-600 bg-sky-950 text-sky-300' },
  verification: {
    label: 'verification',
    className: 'border-emerald-600 bg-emerald-950 text-emerald-300',
  },
  system: { label: 'system', className: 'border-dashed border-zinc-700 text-zinc-500' },
};

// Runtime fallback (api.ts's IssueAnnotation contract): a `kind` this build doesn't know —
// a newer server added one — renders as a neutral badge with the raw kind as its label rather
// than crashing the timeline. The Record above still keeps known kinds exhaustive at the type
// level.
export const kindBadgeStyle = (kind: IssueAnnotation['kind'] | (string & {})): KindBadgeStyle =>
  (KIND_BADGE as Record<string, KindBadgeStyle>)[kind] ?? {
    label: kind,
    className: KIND_BADGE.note.className,
  };

// The add-annotation form's kind selector deliberately excludes 'system' — those rows are
// server-written audit entries on fix-attempt transitions (SPEC §23), not something a human (or
// the dashboard's default 'human' author) should be typing by hand.
export const ADDABLE_ANNOTATION_KINDS = ['note', 'root_cause', 'fix_plan', 'verification'] as const;
export type AddableAnnotationKind = (typeof ADDABLE_ANNOTATION_KINDS)[number];

export const ANNOTATION_BODY_MAX_LENGTH = 16 * 1024; // SPEC §23: body TEXT ≤16KB (413 over cap)

export const hasPrevAnnotationsPage = (offset: number): boolean => offset > 0;

export const hasNextAnnotationsPage = (offset: number, limit: number, total: number): boolean =>
  offset + limit < total;
