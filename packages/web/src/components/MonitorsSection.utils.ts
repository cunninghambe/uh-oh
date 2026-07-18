// Pure helpers for MonitorsSection.tsx (v0.5 CONTRACT M), split out for unit testing without
// rendering.

import type { Monitor } from '../api.js';

export type StatusPillStyle = { label: string; className: string };

// 'missed' is deliberately the loudest of the three — a missed monitor is a dead-man's-switch
// firing, the whole point of this feature (brief: "Status pill for 'missed' should be
// prominent"). Record<Monitor['status'], …> keeps this exhaustive: a new status added to the
// union would fail to typecheck here until handled.
const STATUS_PILL: Record<Monitor['status'], StatusPillStyle> = {
  ok: { label: 'ok', className: 'border-emerald-600 bg-emerald-950 text-emerald-300' },
  missed: {
    label: 'missed',
    className: 'border-red-500 bg-red-950 text-red-300 font-semibold animate-pulse',
  },
  paused: { label: 'paused', className: 'border-zinc-700 bg-zinc-900 text-zinc-500' },
};

export const statusPillStyle = (status: Monitor['status']): StatusPillStyle => STATUS_PILL[status];

/** The check-in URL pattern for a project, with its real publicKey substituted in (brief:
 * "render it with the project's actual publicKey for copy-paste") — `<slug>`/`N` stay as
 * placeholders since those are per-monitor, chosen by whatever's checking in. */
export const checkInUrlPattern = (publicKey: string): string =>
  `POST /ingest/${publicKey}/check-in/<slug>?intervalMinutes=N`;

/** Label for the pause/resume row action — the only two PATCH-able status values, so a paused
 * monitor's only forward action is resume, and an ok/missed monitor's only action is pause. */
export const toggleStatusAction = (
  status: Monitor['status'],
): { label: string; next: 'ok' | 'paused' } =>
  status === 'paused' ? { label: 'Resume', next: 'ok' } : { label: 'Pause', next: 'paused' };
