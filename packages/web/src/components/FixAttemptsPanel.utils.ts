// Pure helpers for FixAttemptsPanel.tsx (v0.8 CONTRACT — SPEC §23 fix attempts), split out for
// unit testing without rendering, same rationale/shape as MonitorsSection.utils.ts's
// STATUS_PILL/statusPillStyle.

import type { FixAttempt } from '../api.js';

export type StatePillStyle = { label: string; className: string };

// SPEC §23 brief: "distinct colors: filed neutral, deployed blue-ish, verified green, failed red
// — match the app's existing palette". sky-* is the app's one existing "blue" (see
// UsageTrendChart.tsx's visitors line); emerald/red mirror MonitorsSection's ok/missed pills.
const STATE_PILL: Record<FixAttempt['state'], StatePillStyle> = {
  filed: { label: 'filed', className: 'border-zinc-700 bg-zinc-900 text-zinc-400' },
  deployed: { label: 'deployed', className: 'border-sky-600 bg-sky-950 text-sky-300' },
  verified: { label: 'verified', className: 'border-emerald-600 bg-emerald-950 text-emerald-300' },
  failed: { label: 'failed', className: 'border-red-600 bg-red-950 text-red-300' },
};

export const fixAttemptStateStyle = (state: FixAttempt['state']): StatePillStyle =>
  STATE_PILL[state];
