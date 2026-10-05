// Browser transport and pipeline hardening.
//
// 1. Beacon bodies are text/plain. navigator.sendBeacon always sends with
//    credentials mode "include". A Blob typed application/json is not a
//    CORS-safelisted type, so the browser preflights it, and a preflight
//    answered "Access-Control-Allow-Origin: *" fails for a credentialed
//    request: the POST is never sent. Reproduced in Chrome 154 against the
//    production server build: a lone OPTIONS /ingest/<key>/usage, no POST,
//    which is exactly what err.autogeny.ai's access log shows for every
//    browser. A text/plain body is a CORS "simple" request (no preflight); the
//    ingest routes parse text/plain bodies as JSON.
// 2. The internal async pipeline never rejects. Every send, drain and timer
//    path is catch-all'd, so even a host timer that throws (the "Illegal
//    invocation" browsers raise for an unbound window.setTimeout) cannot
//    surface as an unhandled rejection, which the client's own
//    unhandledrejection handler would capture, send, fail, and capture again.
// 3. A value JSON cannot serialize (a BigInt, a cycle) in context, user or
//    breadcrumb data never wedges the queue. Before, JSON.stringify threw
//    inside sendOne, which read as a network error: the event stayed at the
//    head of the queue forever and blocked every event behind it.
// 4. Bodies over the 64 KiB keepalive quota still leave the browser. Chrome
//    refuses a keepalive fetch whose body would take the in-flight keepalive
//    bytes past 64 KiB with "TypeError: Failed to fetch" before any network
//    activity, and sendBeacon returns false for the same body. A crash with
//    100 breadcrumbs of 1 KB read as a network error on every retry, so it sat
//    at the head of the queue and every crash behind it waited.
// 5. A crash whose POST is still in flight when the page hides is sent once.
//    beaconFlush used to beacon every queued crash, the one being fetched
//    included, although a keepalive fetch outlives the page: the server got
//    it twice (two 202s with one envelope timestamp in Chrome 154). And
//    drainOnce removed queue[0] once the answer came, by then possibly a
//    different crash, which was dropped without ever being sent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import { Client, type EventEnvelope } from './uh-oh-client.js';
import {
  fakeNavigator,
  fakeProcess,
  fakeStorage,
  fakeWindow,
  mockFetch,
  mockRawFetch,
  type FetchInitShape,
} from './test-support.js';

const DSN = 'https://pk@errors.example.com';
const SPOOL_KEY = 'uh-oh:spool';

async function beaconText(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  return (data as { text: () => Promise<string> }).text();
}

function beaconType(data: unknown): string {
  // A string body is sent by the browser as text/plain;charset=UTF-8.
  if (typeof data === 'string') return 'text/plain;charset=utf-8';
  return (data as { type: string }).type;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('beacon bodies are CORS-safelisted text/plain (no preflight)', () => {
  it('crash beacon on pagehide is text/plain and carries a valid envelope', async () => {
    const w = fakeWindow();
    const nav = fakeNavigator({ beaconOk: true });
    const offline = mockFetch([{ reject: true }]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      {
        fetchFn: offline.fn,
        win: w.win,
        doc: { visibilityState: 'visible' },
        navigator: nav.nav,
        storage: fakeStorage().storage,
      },
    );
    c.install();
    c.captureException(new Error('boom'));
    await c.flush();
    expect(c.size()).toBe(1);

    w.dispatch('pagehide', {});
    expect(nav.beaconCalls).toHaveLength(1);
    const data = nav.beaconCalls[0]?.data;
    expect(beaconType(data)).toMatch(/^text\/plain/);
    const env = EventEnvelopeSchema.parse(JSON.parse(await beaconText(data)));
    expect(env.exception.value).toBe('boom');
    c.close();
  });

  it('usage beacon on pagehide is text/plain and carries { events }', async () => {
    const w = fakeWindow();
    const nav = fakeNavigator({ beaconOk: true });
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      {
        fetchFn: mockRawFetch().fn,
        win: w.win,
        doc: { visibilityState: 'visible', referrer: '' },
        navigator: nav.nav,
        storage: fakeStorage().storage,
        setTimeoutFn: () => 0,
        clearTimeoutFn: () => undefined,
      },
    );
    c.install();
    c.trackEvent('clicked');

    w.dispatch('pagehide', {});
    expect(nav.beaconCalls).toHaveLength(1);
    const data = nav.beaconCalls[0]?.data;
    expect(beaconType(data)).toMatch(/^text\/plain/);
    const body = JSON.parse(await beaconText(data)) as { events: Array<{ name?: string }> };
    expect(body.events[0]?.name).toBe('clicked');
    c.close();
  });
});

describe('the async pipeline never rejects', () => {
  let rejections: unknown[];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections = [];
    process.on('unhandledRejection', onRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
  });

  const illegal = (): never => {
    throw new TypeError('Illegal invocation');
  };

  it('a host timer that throws neither rejects nor feeds the capture loop', async () => {
    const w = fakeWindow();
    const f = mockFetch([{ ok: false, status: 503 }]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      {
        fetchFn: f.fn,
        win: w.win,
        doc: { visibilityState: 'visible', referrer: '' },
        navigator: fakeNavigator().nav,
        storage: fakeStorage().storage,
        setTimeoutFn: illegal,
        clearTimeoutFn: illegal,
        setIntervalFn: illegal,
        clearIntervalFn: illegal,
      },
    );
    c.install();
    // The client's own handler is listening, exactly as in a page.
    expect(w.count('unhandledrejection')).toBe(1);

    expect(c.captureException(new Error('first'))).not.toBe('');
    c.trackEvent('still_works');
    await tick();
    await tick();

    expect(rejections).toEqual([]);
    // The send was still attempted (a timer failure must not block fetch)...
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.env.exception.value).toBe('first');
    // ...and the 503 left exactly the one event queued: nothing self-captured.
    expect(c.size()).toBe(1);
    expect(() => c.close()).not.toThrow();
    await tick();
    expect(rejections).toEqual([]);
  });

  it('flush() resolves even when every timer throws', async () => {
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1', runtime: 'node' },
      {
        fetchFn: mockFetch().fn,
        proc: null,
        setTimeoutFn: illegal,
        clearTimeoutFn: illegal,
        setIntervalFn: illegal,
        clearIntervalFn: illegal,
      },
    );
    c.captureException(new Error('x'));
    await expect(c.flush(50)).resolves.toBeUndefined();
    expect(c.size()).toBe(0);
    c.close();
    await tick();
    expect(rejections).toEqual([]);
  });

  it('a spool left by an earlier page plus a throwing setInterval starts no capture loop on install()', async () => {
    // One event left in localStorage, as a tab closed while offline leaves it.
    const store = fakeStorage();
    const seed = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      {
        fetchFn: mockFetch([{ reject: true }]).fn,
        win: fakeWindow().win,
        doc: { visibilityState: 'visible' },
        navigator: fakeNavigator().nav,
        storage: store.storage,
        setIntervalFn: () => 0,
        clearIntervalFn: () => undefined,
      },
    );
    seed.captureException(new Error('left in the spool'));
    await seed.flush();
    seed.close();
    expect(JSON.parse(store.map.get(SPOOL_KEY) ?? '[]')).toHaveLength(1);

    // A browser turns an unhandled rejection into a window event, which the
    // client's own handler captures. Bridge it the same way, capped so a
    // regression fails the test instead of spinning forever.
    const w = fakeWindow();
    let bridged = 0;
    const bridge = (reason: unknown): void => {
      if (bridged++ < 25) w.dispatch('unhandledrejection', { reason });
    };
    process.on('unhandledRejection', bridge);
    try {
      const f = mockFetch([{ ok: false, status: 503 }]);
      const c = new Client(
        { dsn: DSN, release: '1.0.0+1' },
        {
          fetchFn: f.fn,
          win: w.win,
          doc: { visibilityState: 'visible' },
          navigator: fakeNavigator().nav,
          storage: store.storage,
          setIntervalFn: illegal,
          clearIntervalFn: illegal,
        },
      );
      // A clean page load: no error anywhere, only the restored event.
      c.install();
      for (let i = 0; i < 5; i += 1) await tick();

      expect(rejections).toEqual([]);
      expect(bridged).toBe(0);
      // The restored event was tried once; the 503 keeps it, alone.
      expect(f.calls.map((call) => call.env.exception.value)).toEqual(['left in the spool']);
      expect(c.size()).toBe(1);
      expect(JSON.parse(store.map.get(SPOOL_KEY) ?? '[]')).toHaveLength(1);
      expect(() => c.close()).not.toThrow();
    } finally {
      process.off('unhandledRejection', bridge);
    }
  });

  it('an uncaught value that cannot be turned into a string still ends in exit(1)', async () => {
    // As the only uncaughtException listener the client replaces Node's
    // default crash, so its handler must reach exit(1) whatever was thrown.
    // Before, String() on this message threw inside writeStderr: the handler
    // rejected and the process kept running after an uncaught exception.
    const p = fakeProcess();
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      { fetchFn: mockFetch().fn, proc: p.proc },
    );
    c.install();
    const hostile = { message: Object.create(null) as object };
    await expect(p.trigger('uncaughtException', hostile)).resolves.toBeUndefined();
    expect(p.exitCalls).toEqual([1]);
    expect(p.stderrWrites).toHaveLength(1);
    c.close();
  });

  it('checkIn with a throwing timer still pings and never rejects', async () => {
    const f = mockRawFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1', runtime: 'node' },
      { fetchFn: f.fn, proc: null, setTimeoutFn: illegal, clearTimeoutFn: illegal },
    );
    c.checkIn('nightly');
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(rejections).toEqual([]);
    c.close();
  });
});

describe('values JSON cannot serialize never wedge the queue', () => {
  function nodeClient(fetchFn: ReturnType<typeof mockFetch>['fn']): Client {
    return new Client(
      { dsn: DSN, release: '1.0.0+1', runtime: 'node' },
      { fetchFn, proc: null, setIntervalFn: () => 0, clearIntervalFn: () => undefined },
    );
  }

  it('a BigInt in breadcrumb data is stringified, and later events still send', async () => {
    const f = mockFetch();
    const c = nodeClient(f.fn);
    c.addBreadcrumb({ category: 'db', message: 'row', data: { id: BigInt(42) } });
    c.captureException(new Error('one'));
    c.captureException(new Error('two'));
    await c.flush();

    expect(f.calls.map((call) => call.env.exception.value)).toEqual(['one', 'two']);
    expect(c.size()).toBe(0);
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.breadcrumbs[0]?.data).toEqual({ id: '42' });
    c.close();
  });

  it('a cycle in context becomes "[Circular]" instead of blocking the queue', async () => {
    const f = mockFetch();
    const c = nodeClient(f.fn);
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    c.setContext('graph', node);
    c.captureException(new Error('cyclic'));
    await c.flush();

    expect(f.calls).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.context?.['graph']).toEqual({ name: 'root', self: '[Circular]' });
    expect(c.size()).toBe(0);
    c.close();
  });

  it('a value shared by two context keys is kept on both (only true cycles are cut)', async () => {
    const f = mockFetch();
    const c = nodeClient(f.fn);
    const shared = { plan: 'pro' };
    c.setContext('a', { shared });
    c.setContext('b', { shared });
    c.captureException(new Error('shared'));
    await c.flush();
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.context?.['a']).toEqual({ shared: { plan: 'pro' } });
    expect(env.context?.['b']).toEqual({ shared: { plan: 'pro' } });
    c.close();
  });

  it('a throwing toJSON or getter is replaced, not fatal', async () => {
    const f = mockFetch();
    const c = nodeClient(f.fn);
    const hostile = {
      toJSON(): never {
        throw new Error('nope');
      },
    };
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get(): never {
        throw new Error('denied');
      },
    });
    c.setContext('hostile', { hostile, getter });
    c.captureException(new Error('hostile'));
    await c.flush();
    expect(f.calls).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.context?.['hostile']).toEqual({
      hostile: '[unserializable]',
      getter: { secret: '[unserializable]' },
    });
    c.close();
  });

  it('ordinary envelopes are byte-identical to a plain JSON round trip', async () => {
    const f = mockFetch();
    const c = nodeClient(f.fn);
    c.setUser({ id: 'u1', email: 'a@b.c' });
    c.setTag('t', 'v');
    c.setContext('k', { n: 1, when: new Date(0), list: [1, undefined, 'x'] });
    c.addBreadcrumb({ category: 'nav', message: 'm', data: { a: 1 } });
    c.captureException(new Error('plain'));
    await c.flush();
    const sent = f.calls[0]?.init as FetchInitShape;
    const parsed = JSON.parse(sent.body) as EventEnvelope;
    expect(JSON.stringify(parsed)).toBe(sent.body);
    expect(parsed.context?.['k']).toEqual({
      n: 1,
      when: '1970-01-01T00:00:00.000Z',
      list: [1, null, 'x'],
    });
    c.close();
  });
});

describe('bodies over the 64 KiB keepalive quota still leave the browser', () => {
  // What Chromium does with a keepalive request (the Fetch spec's keepalive
  // quota): a body over 64 KiB is refused with "TypeError: Failed to fetch"
  // before anything is sent, and sendBeacon returns false for it. Measured in
  // Chromium 152 and 154: 60,000 bytes reached the server, 65,536 and 70,000
  // bytes did not; without keepalive the 70,000-byte body arrived.
  const KEEPALIVE_QUOTA = 65_536;
  const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

  interface Attempt {
    url: string;
    keepalive: boolean;
    bytes: number;
  }
  interface Delivered {
    url: string;
    init: FetchInitShape;
    body: unknown;
  }

  /**
   * A fetch that behaves like Chrome's. `refuseKeepalive` stands in for the
   * quota being held by other keepalive requests still in flight; `offline`
   * fails every attempt the way a dropped connection does (also a TypeError).
   */
  function chromeFetch(
    opts: { refuseKeepalive?: boolean; offline?: boolean; status?: number } = {},
  ) {
    const attempts: Attempt[] = [];
    const delivered: Delivered[] = [];
    const fn = (url: string, init: FetchInitShape): Promise<{ ok: boolean; status: number }> => {
      const bytes = utf8Bytes(init.body);
      const keepalive = init.keepalive === true;
      attempts.push({ url, keepalive, bytes });
      if (keepalive && (opts.refuseKeepalive === true || bytes > KEEPALIVE_QUOTA)) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (opts.offline === true) return Promise.reject(new TypeError('Failed to fetch'));
      delivered.push({ url, init, body: init.body ? (JSON.parse(init.body) as unknown) : null });
      const status = opts.status ?? 202;
      return Promise.resolve({ ok: status >= 200 && status < 300, status });
    };
    const crashes = (): Delivered[] => delivered.filter((d) => !d.url.endsWith('/usage'));
    const usage = (): Delivered[] => delivered.filter((d) => d.url.endsWith('/usage'));
    const values = (): string[] =>
      crashes().map((d) => EventEnvelopeSchema.parse(d.body).exception.value);
    return { fn, attempts, delivered, crashes, usage, values };
  }

  /** A navigator whose sendBeacon refuses a body over the quota, as Chrome's does. */
  function chromeNavigator() {
    const beaconCalls: Array<{ url: string; bytes: number; data: unknown }> = [];
    const nav = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      language: 'en-US',
      sendBeacon: (url: string, data?: unknown): boolean => {
        const bytes = typeof data === 'string' ? utf8Bytes(data) : (data as { size: number }).size;
        beaconCalls.push({ url, bytes, data });
        return bytes <= KEEPALIVE_QUOTA;
      },
    };
    return { nav, beaconCalls };
  }

  // The follow-up crash carries no trail, as a crash on a fresh page would;
  // the breadcrumb ring buffer is shared, so without this it would be big too.
  const smallHasNoTrail = (e: EventEnvelope): EventEnvelope =>
    e.exception.value === 'small' ? { ...e, breadcrumbs: [] } : e;

  function browserClient(
    fetchFn: ReturnType<typeof chromeFetch>['fn'],
    deps: {
      win?: ReturnType<typeof fakeWindow>['win'];
      navigator?: ReturnType<typeof chromeNavigator>['nav'];
      storage?: ReturnType<typeof fakeStorage>['storage'];
      noTimeouts?: boolean;
    } = {},
  ): Client {
    return new Client(
      { dsn: DSN, release: '1.0.0+1', beforeSend: smallHasNoTrail },
      {
        fetchFn,
        win: deps.win ?? fakeWindow().win,
        doc: { visibilityState: 'visible', referrer: '' },
        navigator: deps.navigator ?? fakeNavigator().nav,
        storage: deps.storage ?? fakeStorage().storage,
        setIntervalFn: () => 0,
        clearIntervalFn: () => undefined,
        ...(deps.noTimeouts === true
          ? { setTimeoutFn: () => 0, clearTimeoutFn: () => undefined }
          : {}),
      },
    );
  }

  /** 100 breadcrumbs (the default cap) of about 1 KB each. */
  function addTrail(c: Client, unit = 'x', perCrumb = 1000): void {
    for (let i = 0; i < 100; i += 1) {
      c.addBreadcrumb({ category: 'log', message: `${String(i)} ${unit.repeat(perCrumb)}` });
    }
  }

  // Ten props at the 256-char value cap. "é" is one UTF-16 unit but two UTF-8
  // bytes, so a full batch of 20 is under 60,000 characters and over 100,000
  // bytes: the check has to count bytes.
  const heavyProps: Record<string, string> = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`p${String(i)}`, 'é'.repeat(256)]),
  );

  it('a crash with 100 x 1 KB breadcrumbs and a small crash behind it are both delivered', async () => {
    const f = chromeFetch();
    const c = browserClient(f.fn);
    addTrail(c);
    c.captureException(new Error('big'));
    c.captureException(new Error('small'));
    await c.flush();

    expect(f.values()).toEqual(['big', 'small']);
    expect(c.size()).toBe(0);
    const [big, small] = f.crashes();
    expect(utf8Bytes(big?.init.body ?? '')).toBeGreaterThan(KEEPALIVE_QUOTA);
    // Sent whole (no trimming) and without keepalive, which Chrome would refuse.
    expect(EventEnvelopeSchema.parse(big?.body).breadcrumbs).toHaveLength(100);
    expect(big?.init.keepalive).not.toBe(true);
    // The small crash still gets keepalive, so it can outlive the page.
    expect(small?.init.keepalive).toBe(true);
    // No doomed keepalive attempt was made first: two crashes, two requests.
    expect(f.attempts).toHaveLength(2);
    expect(f.attempts.filter((a) => a.keepalive && a.bytes > 60_000)).toEqual([]);
    c.close();
  });

  it('measures the body in UTF-8 bytes, not string length', async () => {
    const f = chromeFetch();
    const c = browserClient(f.fn);
    addTrail(c, 'é', 400);
    c.captureException(new Error('big'));
    await c.flush();

    const sent = f.crashes()[0];
    expect(sent?.init.body.length).toBeLessThan(60_000);
    expect(utf8Bytes(sent?.init.body ?? '')).toBeGreaterThan(KEEPALIVE_QUOTA);
    expect(sent?.init.keepalive).not.toBe(true);
    expect(f.values()).toEqual(['big']);
    expect(c.size()).toBe(0);
    c.close();
  });

  it('a keepalive send refused with a TypeError is retried once without keepalive', async () => {
    // The quota is shared by every keepalive request in flight, so even a
    // small body is refused while a large keepalive request is still going.
    const f = chromeFetch({ refuseKeepalive: true });
    const c = browserClient(f.fn);
    c.captureException(new Error('small'));
    await c.flush();

    expect(f.attempts.map((a) => a.keepalive)).toEqual([true, false]);
    expect(f.values()).toEqual(['small']);
    expect(c.size()).toBe(0);
    c.close();
  });

  // The next two watch a single drain pass (the one captureException starts):
  // flush() would request a second pass and double the attempts.

  it('offline, a crash gets exactly one plain retry and then stays queued', async () => {
    const f = chromeFetch({ offline: true });
    const c = browserClient(f.fn);
    c.captureException(new Error('small'));
    await tick();
    await tick();

    expect(f.attempts.map((a) => a.keepalive)).toEqual([true, false]);
    expect(c.size()).toBe(1);
    c.close();
  });

  it('a rejection that is not a TypeError (an abort) is not retried', async () => {
    const attempts: FetchInitShape[] = [];
    const aborting = (
      _url: string,
      init: FetchInitShape,
    ): Promise<{ ok: boolean; status: number }> => {
      attempts.push(init);
      return Promise.reject(
        Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
      );
    };
    const c = browserClient(aborting);
    c.captureException(new Error('small'));
    await tick();
    await tick();

    expect(attempts.map((i) => i.keepalive)).toEqual([true]);
    expect(c.size()).toBe(1);
    c.close();
  });

  it('a usage batch over the quota is sent without keepalive instead of being dropped', async () => {
    const f = chromeFetch();
    const c = browserClient(f.fn, { noTimeouts: true });
    // The 20th event fills the batch and sends it at once.
    for (let i = 0; i < 20; i += 1) c.trackEvent('heavy', heavyProps);
    await tick();
    await tick();

    const batch = f.usage()[0];
    expect(batch?.init.body.length).toBeLessThan(60_000);
    expect(utf8Bytes(batch?.init.body ?? '')).toBeGreaterThan(KEEPALIVE_QUOTA);
    expect(batch?.init.keepalive).not.toBe(true);
    expect((batch?.body as { events: unknown[] }).events).toHaveLength(20);
    c.close();
  });

  it('pagehide keeps an oversized crash for the next page instead of beaconing it; the next page sends it', async () => {
    const store = fakeStorage();
    const w = fakeWindow();
    const chrome = chromeNavigator();
    const down = chromeFetch({ status: 503 });
    const c = browserClient(down.fn, { win: w.win, navigator: chrome.nav, storage: store.storage });
    c.install();
    addTrail(c);
    c.captureException(new Error('big'));
    c.captureException(new Error('small'));
    await c.flush();
    expect(c.size()).toBe(2);

    w.dispatch('pagehide', {});
    // Only the crash that fits was handed to sendBeacon...
    expect(chrome.beaconCalls).toHaveLength(1);
    const beaconed = EventEnvelopeSchema.parse(
      JSON.parse(await beaconText(chrome.beaconCalls[0]?.data)),
    );
    expect(beaconed.exception.value).toBe('small');
    expect(chrome.beaconCalls[0]?.bytes).toBeLessThanOrEqual(60_000);
    // ...and the oversized one stays queued and persisted.
    expect(c.size()).toBe(1);
    const spooled = JSON.parse(store.map.get(SPOOL_KEY) ?? '[]') as Array<{ env: EventEnvelope }>;
    expect(spooled.map((item) => item.env.exception.value)).toEqual(['big']);
    c.close();

    // The next page load restores it and sends it by plain fetch.
    const up = chromeFetch();
    const next = browserClient(up.fn, { storage: store.storage });
    next.install();
    await next.flush();
    expect(up.values()).toEqual(['big']);
    expect(up.crashes()[0]?.init.keepalive).not.toBe(true);
    expect(next.size()).toBe(0);
    expect(store.map.has(SPOOL_KEY)).toBe(false);
    next.close();
  });

  it('an oversized usage batch at pagehide goes by plain fetch, not a beacon Chrome would refuse', async () => {
    const w = fakeWindow();
    const chrome = chromeNavigator();
    const f = chromeFetch();
    const c = browserClient(f.fn, { win: w.win, navigator: chrome.nav, noTimeouts: true });
    c.install();
    // 19 events: one short of the batch cap, so nothing is sent yet.
    for (let i = 0; i < 19; i += 1) c.trackEvent('heavy', heavyProps);
    expect(f.attempts).toHaveLength(0);

    w.dispatch('pagehide', {});
    await tick();
    await tick();
    expect(chrome.beaconCalls).toHaveLength(0);
    const batch = f.usage()[0];
    expect(batch?.init.keepalive).not.toBe(true);
    expect((batch?.body as { events: unknown[] }).events).toHaveLength(19);
    c.close();
  });

  it('a small usage batch at pagehide still goes by beacon', () => {
    const w = fakeWindow();
    const chrome = chromeNavigator();
    const f = chromeFetch();
    const c = browserClient(f.fn, { win: w.win, navigator: chrome.nav, noTimeouts: true });
    c.install();
    c.trackEvent('light', { plan: 'pro' });

    w.dispatch('pagehide', {});
    expect(chrome.beaconCalls).toHaveLength(1);
    expect(chrome.beaconCalls[0]?.url).toBe('https://errors.example.com/ingest/pk/usage');
    expect(f.attempts).toHaveLength(0);
    c.close();
  });
});

describe('a crash whose POST is in flight when the page hides is sent once', () => {
  interface Held {
    value: string;
    keepalive: boolean;
    answer: (status: number) => void;
    /** Rejects the request as Chromium does when the page unloads mid-request. */
    fail: () => void;
    /** Rejects it as the client's own send timeout does (an AbortError). */
    abort: () => void;
  }

  /**
   * A fetch whose every request stays in flight until the test answers it.
   * With `refuseKeepalive` a keepalive request is refused at once with a
   * TypeError, as Chrome does when the keepalive quota is taken; the plain
   * retry is then held like any other.
   */
  function heldFetch(opts: { refuseKeepalive?: boolean } = {}) {
    const held: Held[] = [];
    const fn = (_url: string, init: FetchInitShape): Promise<{ ok: boolean; status: number }> => {
      const keepalive = init.keepalive === true;
      if (keepalive && opts.refuseKeepalive === true) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return new Promise((resolve, reject) => {
        held.push({
          value: (JSON.parse(init.body) as EventEnvelope).exception.value,
          keepalive,
          answer: (status) => resolve({ ok: status >= 200 && status < 300, status }),
          fail: () => reject(new TypeError('Failed to fetch')),
          abort: () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
        });
      });
    };
    return { fn, held, values: (): string[] => held.map((h) => h.value) };
  }

  function page(fetchFn: ReturnType<typeof heldFetch>['fn']) {
    const w = fakeWindow();
    const doc = { visibilityState: 'visible', referrer: '' };
    const nav = fakeNavigator({ beaconOk: true });
    const store = fakeStorage();
    const c = new Client(
      { dsn: DSN, release: '1.0.0+1' },
      {
        fetchFn,
        win: w.win,
        doc,
        navigator: nav.nav,
        storage: store.storage,
        setIntervalFn: () => 0,
        clearIntervalFn: () => undefined,
      },
    );
    c.install();
    const hide = (how: 'pagehide' | 'visibilitychange'): void => {
      doc.visibilityState = 'hidden';
      w.dispatch(how, {});
    };
    const spooled = (): string[] =>
      (JSON.parse(store.map.get(SPOOL_KEY) ?? '[]') as Array<{ env: EventEnvelope }>).map(
        (item) => item.env.exception.value,
      );
    const beaconed = (): Promise<string[]> =>
      Promise.all(
        nav.beaconCalls.map(
          async (b) => (JSON.parse(await beaconText(b.data)) as EventEnvelope).exception.value,
        ),
      );
    return { c, hide, spooled, beaconed, store };
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await tick();
  };

  it.each(['pagehide', 'visibilitychange'] as const)(
    'on %s the in-flight crash is not beaconed, and the crash captured after it is sent next',
    async (how) => {
      const f = heldFetch();
      const p = page(f.fn);
      p.c.captureException(new Error('A'));
      await settle();
      expect(f.values()).toEqual(['A']);
      expect(f.held[0]?.keepalive).toBe(true);

      p.hide(how);
      // Its keepalive fetch outlives the page: no beacon, and not in the spool
      // either, or the next page load would send it again.
      expect(await p.beaconed()).toEqual([]);
      expect(p.spooled()).toEqual([]);
      expect(p.c.size()).toBe(1);

      p.c.captureException(new Error('B'));
      expect(p.spooled()).toEqual(['B']);

      f.held[0]?.answer(202);
      await settle();
      // A is gone, B was neither dropped nor sent twice: it is the next request.
      expect(f.values()).toEqual(['A', 'B']);
      expect(p.c.size()).toBe(1);
      expect(p.spooled()).toEqual(['B']);

      f.held[1]?.answer(202);
      await settle();
      expect(f.values()).toEqual(['A', 'B']);
      expect(p.c.size()).toBe(0);
      expect(p.store.map.has(SPOOL_KEY)).toBe(false);
      expect(await p.beaconed()).toEqual([]);
      p.c.close();
    },
  );

  it.each([
    ['400', [400]],
    ['413, then 413 to the trimmed retry', [413, 413]],
    ['413, then 202 to the trimmed retry', [413, 202]],
  ] as const)(
    'an in-flight crash answered %s is removed by id; the crash behind it is sent next',
    async (_label, answers) => {
      const f = heldFetch();
      const p = page(f.fn);
      p.c.captureException(new Error('A'));
      await settle();
      p.hide('visibilitychange');
      p.c.captureException(new Error('B'));

      for (const [i, status] of answers.entries()) {
        f.held[i]?.answer(status);
        await settle();
      }
      expect(f.values()).toEqual([...answers.map(() => 'A'), 'B']);
      expect(p.c.size()).toBe(1);
      expect(p.spooled()).toEqual(['B']);
      p.c.close();
    },
  );

  it('413 then 503 keeps the trimmed in-flight crash without overwriting the one behind it', async () => {
    const f = heldFetch();
    const p = page(f.fn);
    p.c.captureException(new Error('A'));
    await settle();
    p.hide('visibilitychange');
    p.c.captureException(new Error('B'));

    f.held[0]?.answer(413);
    await settle();
    f.held[1]?.answer(503);
    await settle();
    expect(p.c.size()).toBe(2);
    expect(p.spooled()).toEqual(['A', 'B']);
    expect(await p.beaconed()).toEqual([]);
    p.c.close();
  });

  it('when the in-flight crash fails after the page hid, it is kept and spooled for a retry', async () => {
    const f = heldFetch();
    const p = page(f.fn);
    p.c.captureException(new Error('A'));
    await settle();
    p.hide('visibilitychange');
    expect(p.spooled()).toEqual([]);

    f.held[0]?.answer(503);
    await settle();
    expect(await p.beaconed()).toEqual([]);
    expect(p.c.size()).toBe(1);
    expect(p.spooled()).toEqual(['A']);
    p.c.close();
  });

  it('a keepalive request rejected as the page unloads is not sent again, now or next page', async () => {
    // Chromium 149 rejects the in-flight keepalive fetch with "TypeError:
    // Failed to fetch" 1 ms after pagehide, while the POST itself still
    // reaches the server. Read as a quota refusal, it was retried without
    // keepalive and written back to the spool, and the next page sent it again.
    const f = heldFetch();
    const p = page(f.fn);
    p.c.captureException(new Error('A'));
    await settle();
    p.hide('pagehide');
    f.held[0]?.fail();
    await settle();

    expect(f.values()).toEqual(['A']);
    expect(await p.beaconed()).toEqual([]);
    expect(p.spooled()).toEqual([]);
    expect(p.c.size()).toBe(0);
    p.c.close();
  });

  it('a keepalive request our own timeout aborts after the page hid is kept and spooled', async () => {
    // An abort cancels even a keepalive request, so this crash did not leave.
    const f = heldFetch();
    const p = page(f.fn);
    p.c.captureException(new Error('A'));
    await settle();
    p.hide('visibilitychange');
    f.held[0]?.abort();
    await settle();

    expect(f.values()).toEqual(['A']);
    expect(await p.beaconed()).toEqual([]);
    expect(p.spooled()).toEqual(['A']);
    expect(p.c.size()).toBe(1);
    p.c.close();
  });

  it('a send without keepalive dies with the page: not beaconed, kept in the spool', async () => {
    // Refused keepalive, retried plain (the quota is held by other requests).
    const f = heldFetch({ refuseKeepalive: true });
    const p = page(f.fn);
    p.c.captureException(new Error('A'));
    await settle();
    expect(f.held.map((h) => [h.value, h.keepalive])).toEqual([['A', false]]);

    p.hide('pagehide');
    expect(await p.beaconed()).toEqual([]);
    expect(p.spooled()).toEqual(['A']);
    expect(p.c.size()).toBe(1);

    // The unload cancels the plain request; the spool still has it.
    f.held[0]?.fail();
    await settle();
    expect(p.spooled()).toEqual(['A']);
    expect(p.c.size()).toBe(1);
    p.c.close();
  });

  it('an oversized crash in flight (no keepalive) is not beaconed and stays spooled', async () => {
    const f = heldFetch();
    const p = page(f.fn);
    for (let i = 0; i < 100; i += 1) {
      p.c.addBreadcrumb({ category: 'log', message: `${String(i)} ${'x'.repeat(1000)}` });
    }
    p.c.captureException(new Error('big'));
    await settle();
    expect(f.held.map((h) => [h.value, h.keepalive])).toEqual([['big', false]]);

    p.hide('pagehide');
    expect(await p.beaconed()).toEqual([]);
    expect(p.spooled()).toEqual(['big']);
    p.c.close();
  });

  it('an answer for a crash the 50-event cap already evicted removes nothing else', async () => {
    const f = heldFetch();
    const p = page(f.fn);
    p.c.captureException(new Error('e0'));
    await settle();
    for (let i = 1; i <= 50; i += 1) p.c.captureException(new Error(`e${String(i)}`));
    await settle();
    // e0 is in flight; the 51st capture pushed it out of the queue.
    expect(f.values()).toEqual(['e0']);
    expect(p.c.size()).toBe(50);

    f.held[0]?.answer(202);
    await settle();
    // e1, the new head, is sent next instead of being dropped unsent.
    expect(f.values()).toEqual(['e0', 'e1']);
    expect(p.c.size()).toBe(50);
    p.c.close();
  });
});
