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

// v0.9 CONTRACT (SPEC §24 uptime probes): `kind` is optional/absent on a row from an older server
// build that predates migration 0008 — every such row is a check-in monitor (the only kind that
// existed before), so undefined defaults to 'checkin' here rather than being treated as "unknown"
// (same forward-compat convention as Issue.utils.ts's resolvedPlatform falling back for an absent
// field).
export const monitorKind = (monitor: Pick<Monitor, 'kind'>): 'checkin' | 'http' =>
  monitor.kind ?? 'checkin';

// SPEC §24: "timeoutMs? (default 10000, cap 30000)" — the create form pre-fills the server
// default and enforces the same cap client-side (the server re-validates regardless).
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const MAX_HTTP_TIMEOUT_MS = 30_000;

// No interval default is specced for http monitors (unlike timeoutMs) — 5 minutes is a
// reasonable uptime-probe cadence and matches this dashboard's other "5" (the monitor sweep
// tick), used only to pre-fill the create form; the user can change it before submitting.
export const DEFAULT_HTTP_INTERVAL_MINUTES = 5;

/**
 * The http row's "last probe" line: `hasProbed` false means never probed yet ('never', same
 * empty-state word MonitorRow already uses for `lastCheckInAt`); the `status` string is the raw
 * HTTP status when the probe got one, or 'error' when it failed before a status line (DNS/
 * connect/timeout — SPEC §24's probe failure case) — `lastProbeStatus` alone can't distinguish
 * "never probed" from "probed but errored" since both serialize as null/undefined, hence taking
 * `lastProbeAt` too.
 */
export const httpProbeSummary = (
  monitor: Pick<Monitor, 'lastProbeAt' | 'lastProbeStatus'>,
): { hasProbed: boolean; status: string } => {
  if (monitor.lastProbeAt === null || monitor.lastProbeAt === undefined) {
    return { hasProbed: false, status: 'never' };
  }
  const status =
    monitor.lastProbeStatus === null || monitor.lastProbeStatus === undefined
      ? 'error'
      : String(monitor.lastProbeStatus);
  return { hasProbed: true, status };
};

// SPEC §24: `slug` is `[a-z0-9-]{1,64}` server-side. Same client-side pre-check pattern as
// Releases.tsx's oversizeError (fail fast, no network round trip for an obviously-bad value) —
// the server re-validates regardless.
export const MONITOR_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
