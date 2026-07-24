// §24 — uptime probe execution. GET semantics (UA, redirect refusal, success =
// 200–399), timeout, and the SSRF guards at probe time (literal-IP + DNS
// re-check), all with an injected fetch + DNS resolver.

import { describe, expect, it, vi } from 'vitest';

import type { DnsLookupAll } from '../webhooks/dispatcher.js';
import { PROBE_USER_AGENT, probeHttpMonitor, type ProbeResult } from './probe.js';

const publicLookup: DnsLookupAll = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
const privateLookup: DnsLookupAll = () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]);

const okFetch = (status: number) =>
  vi.fn(() => Promise.resolve({ status } as Response)) as unknown as typeof fetch;

const monitor = (url: string | null, timeoutMs: number | null = 5000) => ({ url, timeoutMs });

describe('probeHttpMonitor', () => {
  it('succeeds on a 2xx and sends GET with the uptime User-Agent, refusing redirects', async () => {
    const fetchFn = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({ status: 204 } as Response),
    );
    const res = await probeHttpMonitor(monitor('https://svc.example/health'), {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: publicLookup,
    });
    expect(res).toEqual<ProbeResult>({ ok: true, status: 204 });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>)['user-agent']).toBe(PROBE_USER_AGENT);
  });

  it('treats a 3xx as success and a 4xx/5xx as failure carrying the status', async () => {
    const deps = { lookupFn: publicLookup };
    expect(
      await probeHttpMonitor(monitor('https://x.example'), { fetchFn: okFetch(301), ...deps }),
    ).toEqual({ ok: true, status: 301 });
    expect(
      await probeHttpMonitor(monitor('https://x.example'), { fetchFn: okFetch(404), ...deps }),
    ).toEqual({ ok: false, status: 404 });
    expect(
      await probeHttpMonitor(monitor('https://x.example'), { fetchFn: okFetch(500), ...deps }),
    ).toEqual({ ok: false, status: 500 });
  });

  it('rejects a literal private-IP target at probe time WITHOUT fetching', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ status: 200 } as Response));
    const res = await probeHttpMonitor(monitor('http://127.0.0.1/health'), {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: publicLookup,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
    expect(res.error).toMatch(/blocked_url/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects a hostname that resolves to a private address (DNS rebinding) WITHOUT fetching', async () => {
    const fetchFn = vi.fn(() => Promise.resolve({ status: 200 } as Response));
    const res = await probeHttpMonitor(monitor('https://evil.example/health'), {
      fetchFn: fetchFn as unknown as typeof fetch,
      lookupFn: privateLookup,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
    expect(res.error).toBe('blocked_dns:10.0.0.5');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborts and fails when the request exceeds the timeout', async () => {
    // A fetch that never resolves until the AbortController fires.
    const hangingFetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('The operation was aborted'));
        });
      })) as unknown as typeof fetch;
    const res = await probeHttpMonitor(monitor('https://slow.example', 20), {
      fetchFn: hangingFetch,
      lookupFn: publicLookup,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBeNull();
    expect(res.error).toMatch(/abort/i);
  });

  it('fails a monitor with no url', async () => {
    const res = await probeHttpMonitor(monitor(null), {
      fetchFn: okFetch(200),
      lookupFn: publicLookup,
    });
    expect(res).toMatchObject({ ok: false, status: null });
  });
});
