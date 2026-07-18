import { lookup as dnsLookup } from 'node:dns/promises';

import type { Db } from '../db/index.js';
import { getIssue } from '../db/repos/issues.js';
import { getEvent } from '../db/repos/events.js';
import { getProjectById } from '../db/repos/projects.js';
import { takeDueDispatches, markDispatchAttempt } from '../db/repos/webhook-dispatches.js';
import { metrics } from '../metrics/registry.js';
import { isBlockedIp, isIpLiteralHost, validateWebhookUrl } from './url-guard.js';

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

const buildPayload = (
  db: Db,
  dispatch: { id: string; issueId: string; eventId: string; type: 'issue.new' | 'issue.regressed' },
  dashboardUrl: string | undefined,
): object | null => {
  const issue = getIssue(db, dispatch.issueId);
  const event = getEvent(db, dispatch.eventId);
  if (!issue || !event) return null;
  const project = getProjectById(db, issue.projectId);
  if (!project) return null;
  return {
    // 'issue.new' for a new-issue alert, 'issue.regressed' for the
    // resolved->regressed transition. Recorded on the row at enqueue time.
    type: dispatch.type,
    // Idempotency hint: receivers can dedupe on dispatchId (at-least-once delivery).
    dispatchId: dispatch.id,
    project: { id: project.id, name: project.name, slug: project.slug },
    issue: {
      id: issue.id,
      fingerprint: issue.fingerprint,
      title: issue.title,
      eventCount: issue.eventCount,
    },
    event: {
      id: event.id,
      level: event.level,
      platform: event.platform,
      receivedAt: event.receivedAt,
    },
    ...(dashboardUrl ? { url: `${dashboardUrl}/issues/${issue.id}` } : {}),
  };
};

const nextAttemptFor = (attempt: number, now: number): number | null =>
  attempt < BACKOFF_MS.length ? now + BACKOFF_MS[attempt]! : null;

/**
 * Attempt a single dispatch. Never rejects: any unexpected error is caught and
 * recorded as a failed attempt so the poll loop cannot be torn down by one row.
 */
const dispatchOne = async (
  db: Db,
  dispatch: {
    id: string;
    issueId: string;
    eventId: string;
    url: string;
    attempt: number;
    type: 'issue.new' | 'issue.regressed';
  },
  fetchFn: typeof fetch,
  lookupFn: DnsLookupAll,
  now: number,
  dashboardUrl: string | undefined,
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

    try {
      const res = await fetchFn(dispatch.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
