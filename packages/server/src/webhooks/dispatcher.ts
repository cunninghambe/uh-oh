import { lookup as dnsLookup } from 'node:dns/promises';

import type { Db } from '../db/index.js';
import { getIssue } from '../db/repos/issues.js';
import { getEvent } from '../db/repos/events.js';
import { getMonitor } from '../db/repos/monitors.js';
import { getProjectById } from '../db/repos/projects.js';
import { computeSpikeStats } from '../db/repos/spikes.js';
import { mostRecentlyDeployedAttempt, toFixAttemptView } from '../db/repos/fix-attempts.js';
import {
  takeDueDispatches,
  markDispatchAttempt,
  type DispatchType,
} from '../db/repos/webhook-dispatches.js';
import type { SpikeStats } from '../db/repos/spikes.js';
import type { FixAttemptView } from '../db/repos/fix-attempts.js';
import type { EventRow } from '../db/schema.js';
import { metrics } from '../metrics/registry.js';
import { DEFAULT_ALERT_LOCAL_TZ, formatAlertMinute } from './alert-time.js';
import { isBlockedIp, isIpLiteralHost, validateWebhookUrl } from './url-guard.js';

/** Fields of a webhook_dispatches row the dispatcher reads. */
type DispatchRecord = {
  id: string;
  issueId: string | null;
  eventId: string | null;
  monitorId: string | null;
  url: string;
  attempt: number;
  type: DispatchType;
  // Enqueue time. issue.spike / fix.verified payloads are computed AS OF this
  // instant so the delivered numbers match what the sweep saw at detection.
  createdAt: number;
};

const BACKOFF_MS = [2000, 8000, 32000] as const;
const FETCH_TIMEOUT_MS = 5000;
const DNS_LOOKUP_TIMEOUT_MS = 2000;

/** A `dns.lookup(host, { all: true })`-shaped resolver; injectable for tests. */
export type DnsLookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookupAll = (hostname) => dnsLookup(hostname, { all: true });

export type DispatcherLogger = {
  error: (msg: string, meta?: object) => void;
  warn?: (msg: string, meta?: object) => void;
};

export type DispatcherDeps = {
  db: Db;
  fetchFn?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  logger?: DispatcherLogger;
  /** DNS resolver for the dispatch-time re-check; injectable for tests. */
  lookupFn?: DnsLookupAll;
  /**
   * Base URL of the dashboard. When unset/empty, the `url` field is omitted from
   * the webhook payload (never emit a dead relative link).
   */
  dashboardUrl?: string | undefined;
  /**
   * IANA zone for the local half of alert timestamps (`UH_OH_ALERT_LOCAL_TZ`,
   * validated at boot). Unset → {@link DEFAULT_ALERT_LOCAL_TZ}.
   */
  alertLocalTz?: string | undefined;
};

/** Reject a promise if it does not settle within `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dns lookup timed out after ${String(ms)}ms`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/**
 * Dispatch-time DNS re-check for hostname targets — defends against DNS
 * rebinding, where a hostname that passed the synchronous literal-IP guard
 * resolves to a private/loopback/link-local/metadata address.
 *
 * TOCTOU caveat: DNS resolution can change between this check and the fetch
 * (fetch resolves the name independently), so this RAISES THE BAR rather than
 * pinning the address. Combined with `redirect: 'error'` and the synchronous
 * literal-IP guard, it closes the common rebinding path without a custom
 * connect/resolver hook.
 *
 * A transient lookup error or timeout is NOT treated as a block — we return
 * `{ blocked: false }` and proceed to fetch (which will fail naturally and be
 * retried) rather than permanently failing a dispatch on flaky DNS.
 */
const resolveHostBlocked = async (
  hostname: string,
  lookupFn: DnsLookupAll,
  logger?: DispatcherLogger,
): Promise<{ blocked: true; address: string } | { blocked: false }> => {
  let records: Array<{ address: string; family: number }>;
  try {
    records = await withTimeout(lookupFn(hostname), DNS_LOOKUP_TIMEOUT_MS);
  } catch (err) {
    logger?.warn?.('webhook dns re-check skipped (lookup failed or timed out)', {
      host: hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return { blocked: false };
  }
  const bad = records.find((r) => isBlockedIp(r.address));
  return bad ? { blocked: true, address: bad.address } : { blocked: false };
};

export type DispatcherHandle = {
  stop: () => Promise<void>;
};

/**
 * The delivered webhook body. Its exact shape (and property order) is the
 * receiver contract — see the per-type comments on the builders below. Fields
 * are optional per event type rather than modelled as a discriminated union so
 * the builders stay literal-for-literal what they were; the translation to
 * other formats (Discord) reads them defensively.
 */
export type WebhookPayload = {
  type: DispatchType;
  dispatchId: string;
  project: { id: string; name: string; slug: string };
  monitor?: {
    id: string;
    slug: string;
    name: string | null;
    intervalMinutes: number;
    graceMinutes: number;
    lastCheckInAt: number | null;
  };
  probe?: { status: number } | { error: string };
  issue?: { id: string; fingerprint: string; title: string; eventCount: number };
  event?: {
    id: string;
    level: EventRow['level'];
    platform: EventRow['platform'];
    receivedAt: number;
  };
  stats?: SpikeStats;
  fixAttempt?: FixAttemptView | null;
  url?: string;
};

const buildMonitorPayload = (
  db: Db,
  dispatch: DispatchRecord,
  dashboardUrl: string | undefined,
): WebhookPayload | null => {
  if (!dispatch.monitorId) return null;
  const monitor = getMonitor(db, dispatch.monitorId);
  if (!monitor) return null;
  const project = getProjectById(db, monitor.projectId);
  if (!project) return null;
  // v0.9 §24: http monitors carry the triggering probe's outcome. The status
  // code is the last probe's (a failing status like 500, or 2xx/3xx on recovery);
  // when there was no HTTP response (timeout / network error / blocked target),
  // last_probe_status is null and we report a generic error instead. Check-in
  // monitors omit `probe` entirely, so their payload stays byte-identical.
  const probe =
    monitor.kind === 'http'
      ? monitor.lastProbeStatus !== null
        ? { status: monitor.lastProbeStatus }
        : { error: 'probe_failed' }
      : undefined;
  return {
    // 'monitor.missed' when the sweep flips it overdue, 'monitor.recovered' when
    // a check-in clears a missed monitor. Recorded on the row at enqueue time.
    type: dispatch.type,
    dispatchId: dispatch.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    monitor: {
      id: monitor.id,
      slug: monitor.slug,
      name: monitor.name,
      intervalMinutes: monitor.intervalMinutes,
      graceMinutes: monitor.graceMinutes,
      lastCheckInAt: monitor.lastCheckInAt,
    },
    ...(probe ? { probe } : {}),
    ...(dashboardUrl ? { url: `${dashboardUrl}/monitors/${monitor.id}` } : {}),
  };
};

/** Common { id, name, slug } / issue summary shared by the issue-scoped payloads. */
const issueSummary = (issue: {
  id: string;
  fingerprint: string;
  title: string;
  eventCount: number;
}) => ({
  id: issue.id,
  fingerprint: issue.fingerprint,
  title: issue.title,
  eventCount: issue.eventCount,
});

// issue.spike — no event; carries the spike stats computed AS OF the dispatch's
// enqueue time so the delivered numbers match what the sweep detected.
const buildSpikePayload = (
  db: Db,
  dispatch: DispatchRecord,
  dashboardUrl: string | undefined,
): WebhookPayload | null => {
  if (!dispatch.issueId) return null;
  const issue = getIssue(db, dispatch.issueId);
  if (!issue) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;
  const stats = computeSpikeStats(db, issue.id, dispatch.createdAt);
  return {
    type: dispatch.type,
    dispatchId: dispatch.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: issueSummary(issue),
    stats: { lastHour: stats.lastHour, baselineHourly: stats.baselineHourly },
    ...(dashboardUrl ? { url: `${dashboardUrl}/issues/${issue.id}` } : {}),
  };
};

// fix.verified — no event; carries the verified attempt (the most-recently
// deployed one as of enqueue time).
const buildFixVerifiedPayload = (
  db: Db,
  dispatch: DispatchRecord,
  dashboardUrl: string | undefined,
): WebhookPayload | null => {
  if (!dispatch.issueId) return null;
  const issue = getIssue(db, dispatch.issueId);
  if (!issue) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;
  const attempt = mostRecentlyDeployedAttempt(db, issue.id, dispatch.createdAt);
  if (!attempt) return null;
  return {
    type: dispatch.type,
    dispatchId: dispatch.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: issueSummary(issue),
    fixAttempt: toFixAttemptView(attempt),
    ...(dashboardUrl ? { url: `${dashboardUrl}/issues/${issue.id}` } : {}),
  };
};

const buildPayload = (
  db: Db,
  dispatch: DispatchRecord,
  dashboardUrl: string | undefined,
): WebhookPayload | null => {
  if (dispatch.type === 'monitor.missed' || dispatch.type === 'monitor.recovered') {
    return buildMonitorPayload(db, dispatch, dashboardUrl);
  }
  if (dispatch.type === 'issue.spike') {
    return buildSpikePayload(db, dispatch, dashboardUrl);
  }
  if (dispatch.type === 'fix.verified') {
    return buildFixVerifiedPayload(db, dispatch, dashboardUrl);
  }

  if (!dispatch.issueId || !dispatch.eventId) return null;
  const issue = getIssue(db, dispatch.issueId);
  const event = getEvent(db, dispatch.eventId);
  if (!issue || !event) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;
  // For a regression, attach the fix attempt that did not hold (the most-recently
  // deployed one) so the receiving agent knows which fix to revisit. Null when the
  // regression was not preceded by a deploy.
  const fixAttempt =
    dispatch.type === 'issue.regressed'
      ? mostRecentlyDeployedAttempt(db, issue.id, dispatch.createdAt)
      : null;
  return {
    // 'issue.new' for a new-issue alert, 'issue.regressed' for the
    // resolved->regressed transition. Recorded on the row at enqueue time.
    type: dispatch.type,
    // Idempotency hint: receivers can dedupe on dispatchId (at-least-once delivery).
    dispatchId: dispatch.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: issueSummary(issue),
    event: {
      id: event.id,
      level: event.level,
      platform: event.platform,
      receivedAt: event.receivedAt,
    },
    ...(dispatch.type === 'issue.regressed'
      ? { fixAttempt: fixAttempt ? toFixAttemptView(fixAttempt) : null }
      : {}),
    ...(dashboardUrl ? { url: `${dashboardUrl}/issues/${issue.id}` } : {}),
  };
};

// ---------------------------------------------------------------------------
// Discord translation
//
// The payload above is uh-oh's own JSON contract, and every non-Discord
// receiver keeps receiving those exact bytes. Discord is the exception it
// cannot be: its webhook endpoint rejects any body without one of `content` /
// `embeds` / `file` (400 invalid_form_body), so pointing a project's
// webhook_url at a Discord webhook silently produced permanent failures — the
// other half of the missed-alarm incident. For a Discord target only, the
// payload is rendered as a one-line `{ content }` message.
// ---------------------------------------------------------------------------

/**
 * Hosts Discord documents for webhooks. Matched EXACTLY, never by suffix, so
 * lookalikes (`evil-discord.com`, `discord.com.attacker.net`) do not qualify
 * and keep the standard payload.
 */
const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
const DISCORD_WEBHOOK_PATH_PREFIX = '/api/webhooks/';

/** Discord's hard limit on `content`; we stay comfortably below it. */
const DISCORD_CONTENT_LIMIT = 2000;
const DISCORD_CONTENT_MAX = DISCORD_CONTENT_LIMIT - 100;
/** Per-field clamp, so one enormous issue title can't push the link out. */
const DISCORD_FIELD_MAX = 180;

/** True when `raw` is a Discord webhook endpoint (host + `/api/webhooks/` path). */
export const isDiscordWebhookUrl = (raw: string): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return (
    DISCORD_WEBHOOK_HOSTS.has(url.hostname.toLowerCase()) &&
    url.pathname.startsWith(DISCORD_WEBHOOK_PATH_PREFIX)
  );
};

/** Collapse whitespace (the summary is one line) and clamp to `max` chars. */
const field = (value: string, max = DISCORD_FIELD_MAX): string => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** `1755777180000` → `2025-08-21 11:53 UTC (07:53 EDT)`; null → `never`. */
const checkInTime = (ms: number | null | undefined, localTz: string): string =>
  ms === null || ms === undefined ? 'never' : formatAlertMinute(ms, localTz);

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * Render a payload as a single-line Discord message body. Always returns a
 * non-empty string under {@link DISCORD_CONTENT_LIMIT} characters — an empty
 * `content` is itself a 400 from Discord. Timestamps render as UTC followed by
 * the time in `localTz` (see alert-time.ts).
 */
export const toDiscordContent = (
  payload: WebhookPayload,
  localTz: string = DEFAULT_ALERT_LOCAL_TZ,
): string => {
  const project = field(payload.project.name);
  const link = payload.url ? ` — ${payload.url}` : '';
  const monitorName = field(payload.monitor?.name ?? payload.monitor?.slug ?? 'monitor');
  const issueTitle = field(payload.issue?.title ?? 'issue');
  const events = plural(payload.issue?.eventCount ?? 0, 'event', 'events');

  let content: string;
  switch (payload.type) {
    case 'monitor.missed':
      content =
        `🔴 Monitor missed: **${monitorName}** (${project}) — ` +
        `last check-in ${checkInTime(payload.monitor?.lastCheckInAt, localTz)}${link}`;
      break;
    case 'monitor.recovered':
      content =
        `🟢 Monitor recovered: **${monitorName}** (${project}) — ` +
        `last check-in ${checkInTime(payload.monitor?.lastCheckInAt, localTz)}${link}`;
      break;
    case 'issue.new':
      content = `💥 New issue: **${issueTitle}** (${project}) — ${events}${link}`;
      break;
    case 'issue.regressed':
      content = `🔁 Issue regressed: **${issueTitle}** (${project}) — ${events}${link}`;
      break;
    case 'issue.spike':
      content =
        `📈 Issue spike: **${issueTitle}** (${project}) — ` +
        `${String(payload.stats?.lastHour ?? 0)} in the last hour vs ` +
        `${(payload.stats?.baselineHourly ?? 0).toFixed(1)}/h baseline${link}`;
      break;
    case 'fix.verified':
      content =
        `✅ Fix verified: **${issueTitle}** (${project})` +
        `${payload.fixAttempt ? ` — ${field(payload.fixAttempt.prUrl)}` : ''}${link}`;
      break;
  }

  return content.length <= DISCORD_CONTENT_MAX
    ? content
    : `${content.slice(0, DISCORD_CONTENT_MAX - 1)}…`;
};

const nextAttemptFor = (attempt: number, now: number): number | null =>
  attempt < BACKOFF_MS.length ? now + BACKOFF_MS[attempt]! : null;

/**
 * Attempt a single dispatch. Never rejects: any unexpected error is caught and
 * recorded as a failed attempt so the poll loop cannot be torn down by one row.
 */
const dispatchOne = async (
  db: Db,
  dispatch: DispatchRecord,
  fetchFn: typeof fetch,
  lookupFn: DnsLookupAll,
  now: number,
  dashboardUrl: string | undefined,
  alertLocalTz: string,
  logger?: DispatcherLogger,
): Promise<void> => {
  try {
    const payload = buildPayload(db, dispatch, dashboardUrl);
    if (!payload) {
      markDispatchAttempt(db, dispatch.id, {
        ok: false,
        statusCode: null,
        error: 'missing issue/event/project',
        at: now,
        nextAttemptAt: null,
      });
      return;
    }

    // Re-validate the URL at dispatch time. Covers rows written before URL
    // validation existed, and rows whose target became unsafe. A blocked URL is
    // a permanent failure (retrying won't help).
    const guard = validateWebhookUrl(dispatch.url);
    if (!guard.ok) {
      logger?.error('webhook url blocked (SSRF guard)', {
        id: dispatch.id,
        url: dispatch.url,
        reason: guard.reason,
      });
      metrics.webhookFailures.inc();
      markDispatchAttempt(db, dispatch.id, {
        ok: false,
        statusCode: null,
        error: `blocked_url:${guard.reason}`,
        at: now,
        nextAttemptAt: null,
      });
      return;
    }

    // Dispatch-time DNS re-check for hostname targets. Literal-IP URLs were
    // already fully vetted by the synchronous guard above, so only hostnames
    // need re-resolution here. A hostname resolving to a blocked address is a
    // permanent failure (an SSRF-rebinding target won't become safe on retry).
    if (!isIpLiteralHost(guard.url.hostname)) {
      const dns = await resolveHostBlocked(guard.url.hostname, lookupFn, logger);
      if (dns.blocked) {
        logger?.error('webhook host resolves to a blocked address (SSRF guard)', {
          id: dispatch.id,
          url: dispatch.url,
          address: dns.address,
        });
        metrics.webhookFailures.inc();
        markDispatchAttempt(db, dispatch.id, {
          ok: false,
          statusCode: null,
          error: `blocked_dns:${dns.address}`,
          at: now,
          nextAttemptAt: null,
        });
        return;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    let statusCode: number | null = null;
    let errorMsg: string | null = null;

    // Discord targets get a `{ content }` message; every other target keeps the
    // uh-oh payload bytes exactly as built above (that shape is the contract).
    const body = isDiscordWebhookUrl(dispatch.url)
      ? JSON.stringify({ content: toDiscordContent(payload, alertLocalTz) })
      : JSON.stringify(payload);

    try {
      const res = await fetchFn(dispatch.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: controller.signal,
        // Do not follow redirects — a 3xx to an internal host would bypass the
        // literal-IP guard above.
        redirect: 'error',
      });
      statusCode = res.status;
      if (res.ok) {
        markDispatchAttempt(db, dispatch.id, { ok: true, statusCode, at: now });
        return;
      }
      errorMsg = `HTTP ${String(statusCode)}`;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }

    const nextAttemptAt = nextAttemptFor(dispatch.attempt, now);
    if (nextAttemptAt === null) {
      metrics.webhookFailures.inc();
      logger?.error('webhook dispatch failed permanently', {
        id: dispatch.id,
        url: dispatch.url,
        error: errorMsg,
        statusCode,
      });
    }

    markDispatchAttempt(db, dispatch.id, {
      ok: false,
      statusCode,
      error: errorMsg ?? 'unknown error',
      at: now,
      nextAttemptAt,
    });
  } catch (err) {
    // Unexpected error (e.g. a DB read/write threw). Record a failed attempt so
    // the row is retried/aged out, and never let this reject the poll's Promise.all.
    logger?.error('webhook dispatchOne unexpected error', {
      id: dispatch.id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      markDispatchAttempt(db, dispatch.id, {
        ok: false,
        statusCode: null,
        error: err instanceof Error ? err.message : String(err),
        at: now,
        nextAttemptAt: nextAttemptFor(dispatch.attempt, now),
      });
    } catch (markErr) {
      logger?.error('webhook markDispatchAttempt failed', {
        id: dispatch.id,
        error: markErr instanceof Error ? markErr.message : String(markErr),
      });
    }
  }
};

export const startDispatcher = (deps: DispatcherDeps): DispatcherHandle => {
  const pollIntervalMs = deps.pollIntervalMs ?? 1000;
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;
  const nowFn = deps.now ?? (() => Date.now());
  const dashboardUrl =
    deps.dashboardUrl && deps.dashboardUrl.length > 0 ? deps.dashboardUrl : undefined;
  const alertLocalTz = deps.alertLocalTz ?? DEFAULT_ALERT_LOCAL_TZ;

  if (!dashboardUrl) {
    deps.logger?.warn?.('UH_OH_DASHBOARD_URL is unset; webhook payloads will omit the "url" field');
  }

  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<Promise<void>>();

  const poll = async (): Promise<void> => {
    if (stopped) return;
    try {
      const now = nowFn();
      const due = takeDueDispatches(deps.db, now, 10);
      const work = due.map((d) => {
        const p = dispatchOne(
          deps.db,
          d,
          fetchFn,
          lookupFn,
          now,
          dashboardUrl,
          alertLocalTz,
          deps.logger,
        ).finally(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
        return p;
      });
      await Promise.all(work);
    } catch (err) {
      // takeDueDispatches (or anything else) threw. Log and keep polling; the
      // dispatcher must never silently die.
      deps.logger?.error('webhook poll iteration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (!stopped) {
        pollTimer = setTimeout(() => void poll(), pollIntervalMs);
      }
    }
  };

  pollTimer = setTimeout(() => void poll(), pollIntervalMs);

  return {
    stop: async () => {
      stopped = true;
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      // Drain any in-flight dispatches so shutdown doesn't drop delivered work.
      await Promise.allSettled([...inFlight]);
    },
  };
};
