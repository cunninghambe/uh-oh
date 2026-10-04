import { type BrowserContext, type Page, expect, test } from '@playwright/test';

import { type IngestHarness, type IngestHit, startIngestHarness } from './ingest-harness.js';

/**
 * Browser ingest, end to end, in real Chromium: the BUILT @uh-oh/js client on one origin posting
 * to the BUILT @uh-oh/server on another (see ingest-harness.ts). Unit tests inject fetch and
 * timers, which is how two production bugs hid for months (SPEC §25): every browser copy up to
 * 0.6.0 threw "Illegal invocation" from its own unbound window timers before any fetch, and its
 * application/json sendBeacon failed a credentialed preflight against
 * `Access-Control-Allow-Origin: *`, so production saw only lone OPTIONS requests. Every spec
 * below fails against the 90d24af client (UH_OH_E2E_JS_CLIENT pointing at that build), and the
 * crash-beacon spec also fails against the 90d24af server (UH_OH_E2E_SERVER_DIST), which
 * answered a text/plain crash body with 400.
 */

const THROWN = 'uh-oh e2e: thrown error';
const REJECTED = 'uh-oh e2e: unhandled rejection';
const QUEUED = 'uh-oh e2e: still queued at pagehide';
const EVENT = 'e2e_click';
const SPOOL_KEY = 'uh-oh:spool';

type UhOhWindow = {
  __uhohReady?: boolean;
  __uhohE2eRejection?: (reason: string) => Promise<void>;
  uhoh: {
    captureException: (err: unknown) => string;
    trackEvent: (name: string, props?: Record<string, string | number | boolean>) => void;
  };
};

/** What the page and Chrome itself reported during one test. */
type Watch = {
  /** console messages plus Chrome's own log entries (CORS errors land there). */
  console: string[];
  pageErrors: string[];
  /** Every unhandledrejection the page saw, by reason message. */
  rejections: string[];
  /**
   * CDP Network.loadingFailed entries that carry a corsErrorStatus or blockedReason. This sees
   * the page's own fetches. A beacon sent while the page unloads is not reliably reported here
   * (against the 90d24af client the wildcard spec's lone OPTIONS left no entry), so the beacon
   * specs prove delivery by what the server received: no OPTIONS, and a no-cors POST answered 202.
   */
  corsFailures: string[];
};

const watchPage = async (context: BrowserContext, page: Page): Promise<Watch> => {
  const watch: Watch = { console: [], pageErrors: [], rejections: [], corsFailures: [] };
  await page.exposeFunction('__uhohE2eRejection', (reason: string) => {
    watch.rejections.push(reason);
  });
  // Registered before the client's own listener, so it sees every rejection, including any the
  // client's pipeline raises itself.
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (ev) => {
      const reason: unknown = ev.reason;
      const text = reason instanceof Error ? reason.message : String(reason);
      void (window as unknown as UhOhWindow).__uhohE2eRejection?.(text);
    });
  });
  page.on('console', (m) => watch.console.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => watch.pageErrors.push(e.message));

  const cdp = await context.newCDPSession(page);
  const requests = new Map<string, string>();
  cdp.on('Network.requestWillBeSent', (e) => {
    requests.set(e.requestId, `${e.request.method} ${e.request.url}`);
  });
  cdp.on('Network.loadingFailed', (e) => {
    if (e.corsErrorStatus === undefined && e.blockedReason === undefined) return;
    watch.corsFailures.push(
      `${requests.get(e.requestId) ?? e.requestId}: ` +
        `${e.corsErrorStatus?.corsError ?? ''} ${e.blockedReason ?? ''} ${e.errorText}`,
    );
  });
  cdp.on('Log.entryAdded', (e) => watch.console.push(`log ${e.entry.level}: ${e.entry.text}`));
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  return watch;
};

const openApp = async (page: Page, h: IngestHarness): Promise<void> => {
  await page.goto(`${h.appOrigin}/app`);
  await page.waitForFunction(() => (window as unknown as UhOhWindow).__uhohReady === true);
};

type UsageEvent = { type?: unknown; path?: unknown; name?: unknown };

const usageEvents = (hit: IngestHit): UsageEvent[] => {
  const events = (hit.body as { events?: unknown } | undefined)?.events;
  return Array.isArray(events) ? (events as UsageEvent[]) : [];
};

const crashSummary = (hit: IngestHit): Record<string, unknown> => {
  const exception = (hit.body as { exception?: { value?: unknown; mechanism?: unknown } })
    ?.exception;
  return { status: hit.status, value: exception?.value, mechanism: exception?.mechanism };
};

const attachEvidence = async (name: string, hits: IngestHit[], watch: Watch): Promise<void> => {
  await test.info().attach(name, {
    contentType: 'application/json',
    body: JSON.stringify({ hits, ...watch, console: watch.console.slice(0, 200) }, null, 1),
  });
};

test.describe('browser ingest (built client -> built server, cross-origin)', () => {
  let h: IngestHarness;

  test.beforeAll(async () => {
    h = await startIngestHarness();
  });

  test.afterAll(async () => {
    if (h) await h.close();
  });

  test.beforeEach(({ browserName }) => {
    test.skip(browserName !== 'chromium', 'reads CORS failures over the Chrome DevTools Protocol');
  });

  test('crashes, rejections, the analytics flush and the pagehide beacon all land', async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    const watch = await watchPage(context, page);
    const from = h.hits.length;
    const run = (): IngestHit[] => h.hits.slice(from);
    const eventPath = `/ingest/${h.publicKey}`;
    const usagePath = `${eventPath}/usage`;
    const posts = (p: string): IngestHit[] =>
      run().filter((x) => x.method === 'POST' && x.path === p);

    try {
      await openApp(page, h);

      // 1. An uncaught error, thrown from a task: window 'error' -> fetch POST /ingest/:key.
      await page.evaluate((msg) => {
        setTimeout(() => {
          throw new Error(msg);
        }, 0);
      }, THROWN);
      await expect
        .poll(() => posts(eventPath).map(crashSummary), {
          message: 'the thrown error is delivered with 202',
          timeout: 10_000,
        })
        .toContainEqual({ status: 202, value: THROWN, mechanism: 'js-global' });

      // 2. An unhandled promise rejection: window 'unhandledrejection' -> fetch POST.
      await page.evaluate((msg) => {
        void Promise.reject(new Error(msg));
      }, REJECTED);
      await expect
        .poll(() => posts(eventPath).map(crashSummary), {
          message: 'the unhandled rejection is delivered with 202',
          timeout: 10_000,
        })
        .toContainEqual({ status: 202, value: REJECTED, mechanism: 'js-promise' });

      // 3. The auto pageview, flushed by the 5 s analytics timer over fetch (application/json).
      await expect
        .poll(
          () =>
            posts(usagePath).map((x) => ({
              status: x.status,
              fetch: x.contentType?.startsWith('application/json') ?? false,
              events: usageEvents(x).map((e) => `${String(e.type)} ${String(e.path)}`),
            })),
          { message: 'the 5 s analytics flush posts the pageview', timeout: 10_000 },
        )
        .toContainEqual({ status: 202, fetch: true, events: ['pageview /app'] });

      // 4. A custom event, then leave: pagehide -> sendBeacon, text/plain, no preflight.
      await page.evaluate((name) => {
        (window as unknown as UhOhWindow).uhoh.trackEvent(name, { n: 1 });
      }, EVENT);
      await page.goto(`${h.appOrigin}/other`);
      await expect
        .poll(
          () =>
            posts(usagePath)
              .filter((x) => usageEvents(x).some((e) => e.name === EVENT))
              .map((x) => ({
                status: x.status,
                // Chrome lowercases the charset the client sets (text/plain;charset=UTF-8).
                contentType: x.contentType?.toLowerCase() ?? null,
                secFetchMode: x.secFetchMode,
              })),
          { message: 'the pagehide beacon carries the custom event', timeout: 10_000 },
        )
        .toEqual([
          { status: 202, contentType: 'text/plain;charset=utf-8', secFetchMode: 'no-cors' },
        ]);

      // Every POST the page made was accepted; nothing failed a CORS check in Chrome.
      expect(run().filter((x) => x.method === 'POST' && x.status !== 202)).toEqual([]);
      expect(watch.corsFailures).toEqual([]);
      // The client never threw on its own timers, and raised no rejection of its own: the only
      // unhandled rejection the page saw is the one this test made.
      expect(
        [...watch.console, ...watch.pageErrors].filter((m) => m.includes('Illegal invocation')),
      ).toEqual([]);
      expect(watch.rejections).toEqual([REJECTED]);
      expect(watch.pageErrors).toEqual([THROWN, REJECTED]);
      // Everything was delivered, so nothing is left in the spool for the next page load.
      expect(await page.evaluate((key) => localStorage.getItem(key), SPOOL_KEY)).toBeNull();
    } finally {
      await attachEvidence('ingest-evidence', run(), watch);
    }
  });

  test('the pagehide beacon needs no preflight, even against Access-Control-Allow-Origin: *', async ({
    context,
    page,
  }) => {
    test.setTimeout(30_000);
    const watch = await watchPage(context, page);
    const from = h.hits.length;
    const run = (): IngestHit[] => h.hits.slice(from);
    const usagePath = `/ingest/${h.publicKey}/usage`;

    // The wildcard answer a credentialed request cannot pass: the 90d24af server sent it, and so
    // would any proxy that rewrites CORS. A text/plain beacon is a CORS simple request, so Chrome
    // sends it no-cors and never asks.
    h.setForceWildcard(true);
    try {
      await openApp(page, h);
      await page.evaluate((name) => {
        (window as unknown as UhOhWindow).uhoh.trackEvent(name, { n: 2 });
      }, EVENT);
      // Leave before the 5 s timer, so the queued pageview and event go out by beacon.
      await page.goto(`${h.appOrigin}/other`);

      await expect
        .poll(
          () =>
            run()
              .filter((x) => x.method === 'POST' && x.path === usagePath)
              .map((x) => ({
                status: x.status,
                // Chrome lowercases the charset the client sets (text/plain;charset=UTF-8).
                contentType: x.contentType?.toLowerCase() ?? null,
                secFetchMode: x.secFetchMode,
                allowOrigin: x.allowOrigin,
                allowCredentials: x.allowCredentials,
                events: usageEvents(x).map((e) => `${String(e.type)} ${String(e.path ?? e.name)}`),
              })),
          { message: 'the pagehide beacon lands against a wildcard server', timeout: 10_000 },
        )
        .toEqual([
          {
            status: 202,
            contentType: 'text/plain;charset=utf-8',
            secFetchMode: 'no-cors',
            allowOrigin: '*',
            allowCredentials: null,
            events: ['pageview /app', `event ${EVENT}`],
          },
        ]);
      expect(run().filter((x) => x.method === 'OPTIONS')).toEqual([]);
      expect(watch.corsFailures).toEqual([]);
      expect(watch.rejections).toEqual([]);
      expect(await page.evaluate((key) => localStorage.getItem(key), SPOOL_KEY)).toBeNull();
    } finally {
      h.setForceWildcard(false);
      await attachEvidence('ingest-evidence-wildcard', run(), watch);
    }
  });

  test('a crash still queued at pagehide leaves by text/plain beacon and lands', async ({
    context,
    page,
  }) => {
    test.setTimeout(30_000);
    const watch = await watchPage(context, page);
    const from = h.hits.length;
    const run = (): IngestHit[] => h.hits.slice(from);
    const eventPath = `/ingest/${h.publicKey}`;
    const crashPosts = (): IngestHit[] =>
      run().filter((x) => x.method === 'POST' && x.path === eventPath);

    // The fetch gets a 503, so the client keeps the event for its 30 s retry; leaving the page
    // first hands it to the pagehide beacon. That beacon is text/plain, which the crash route
    // has to parse as JSON (the 90d24af server answered 400 invalid_envelope).
    h.setFailCrashFetches(true);
    try {
      await openApp(page, h);
      await page.evaluate((msg) => {
        (window as unknown as UhOhWindow).uhoh.captureException(new Error(msg));
      }, QUEUED);
      await expect
        .poll(() => crashPosts().map((x) => `${String(x.status)} ${String(x.contentType)}`), {
          message: 'the fetch attempt is refused first',
          timeout: 10_000,
        })
        .toContain('503 application/json');
      await page.goto(`${h.appOrigin}/other`);

      await expect
        .poll(
          () =>
            crashPosts()
              .filter((x) => x.status !== 503)
              .map((x) => ({
                ...crashSummary(x),
                contentType: x.contentType?.toLowerCase() ?? null,
                secFetchMode: x.secFetchMode,
              })),
          { message: 'the queued crash lands by beacon', timeout: 10_000 },
        )
        .toEqual([
          {
            status: 202,
            value: QUEUED,
            mechanism: 'js-manual',
            contentType: 'text/plain;charset=utf-8',
            secFetchMode: 'no-cors',
          },
        ]);
      expect(watch.corsFailures).toEqual([]);
      expect(watch.rejections).toEqual([]);
      // The beacon was accepted, so the client dropped the event from its persisted queue.
      expect(await page.evaluate((key) => localStorage.getItem(key), SPOOL_KEY)).toBeNull();
    } finally {
      h.setFailCrashFetches(false);
      await attachEvidence('ingest-evidence-crash-beacon', run(), watch);
    }
  });
});
