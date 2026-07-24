// Uptime probe execution (v0.9 §24). One GET against an http monitor's URL,
// governed by the same egress rules as webhook dispatch: the URL is
// SSRF-validated (scheme + literal-IP guard) and, for hostname targets,
// DNS-re-checked against the same private/loopback/metadata blocklist before the
// request; redirects are refused so a 3xx cannot bounce to an internal host. The
// response body is never read past the status line — success is status 200–399.

import type { DnsLookupAll } from '../webhooks/dispatcher.js';
import { isBlockedIp, isIpLiteralHost, validateWebhookUrl } from '../webhooks/url-guard.js';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../db/repos/monitors.js';

/** The User-Agent every probe presents. */
export const PROBE_USER_AGENT = 'uh-oh-uptime/1';
/** DNS re-check timeout (ms) — a slow lookup must not hang a sweep tick. */
const DNS_LOOKUP_TIMEOUT_MS = 2000;

export type ProbeDeps = {
  fetchFn: typeof fetch;
  /** DNS resolver for the probe-time re-check; injectable for tests. */
  lookupFn: DnsLookupAll;
};

/** The result of one probe: `ok` when status is 200–399; `status` null on no response. */
export type ProbeResult = { ok: boolean; status: number | null; error?: string };

/** Reject a promise if it does not settle within `ms`. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
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
 * Probe one http monitor. Returns `{ ok, status, error? }`. A blocked URL (bad
 * scheme / literal private IP) or a hostname resolving to a blocked address is a
 * failure with no HTTP response (status null); a reachable server yields its
 * status, `ok` iff it is 200–399. A transient DNS-lookup failure is NOT treated
 * as blocked (it raises the bar, like the webhook dispatcher) — the fetch
 * proceeds and fails naturally if the host is truly unreachable.
 */
export const probeHttpMonitor = async (
  monitor: { url: string | null; timeoutMs: number | null },
  deps: ProbeDeps,
): Promise<ProbeResult> => {
  const url = monitor.url;
  if (!url) return { ok: false, status: null, error: 'no_url' };

  // SSRF guard at probe time (scheme + literal-IP + localhost), exactly like the
  // webhook dispatcher's dispatch-time re-validation.
  const guard = validateWebhookUrl(url);
  if (!guard.ok) return { ok: false, status: null, error: `blocked_url:${guard.reason}` };

  // Hostname targets get a DNS re-check against the shared blocklist (defends DNS
  // rebinding). Literal-IP hosts were already fully vetted by the guard above.
  if (!isIpLiteralHost(guard.url.hostname)) {
    let records: Array<{ address: string; family: number }> | null = null;
    try {
      records = await withTimeout(deps.lookupFn(guard.url.hostname), DNS_LOOKUP_TIMEOUT_MS);
    } catch {
      records = null; // transient lookup failure → proceed to fetch
    }
    const bad = records?.find((r) => isBlockedIp(r.address));
    if (bad) return { ok: false, status: null, error: `blocked_dns:${bad.address}` };
  }

  const timeoutMs = monitor.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await deps.fetchFn(url, {
      method: 'GET',
      headers: { 'user-agent': PROBE_USER_AGENT },
      signal: controller.signal,
      // A 3xx to an internal host would bypass the guards above.
      redirect: 'error',
    });
    const status = res.status;
    // Success is any 2xx/3xx; the body is intentionally left unread.
    return status >= 200 && status < 400 ? { ok: true, status } : { ok: false, status };
  } catch (err) {
    return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
};
