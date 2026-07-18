// Tests for usage analytics (trackPageview/trackEvent, batching, auto-mode
// SPA tracking). Independent pipeline from the crash queue - see the
// "analytics (usage tracking)" section of uh-oh-client.ts.

import { describe, expect, it } from 'vitest';

import { Client, close, trackEvent, trackPageview } from './uh-oh-client.js';
import {
  fakeHistory,
  fakeLocation,
  fakeNavigator,
  fakeTimers,
  fakeWindow,
  mockRawFetch,
  type FakeTimers,
} from './test-support.js';

const DSN = 'https://pk@errors.example.com';
const USAGE_URL = 'https://errors.example.com/ingest/pk/usage';

interface UsagePayload {
  events: Array<{
    type: string;
    ts?: number;
    path?: string;
    referrer?: string;
    name?: string;
    props?: Record<string, unknown>;
  }>;
}

function usageBody(body: string | undefined): UsagePayload {
  return JSON.parse(body ?? '{}') as UsagePayload;
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

interface ManualOpts {
  runtime?: 'browser' | 'node';
  fetchFn?: ReturnType<typeof mockRawFetch>['fn'];
  win?: ReturnType<typeof fakeWindow>['win'];
  doc?: { visibilityState?: string; referrer?: string };
  navigator?: ReturnType<typeof fakeNavigator>['nav'];
  location?: { pathname?: string };
  timers?: FakeTimers;
}

function manualClient(opts: ManualOpts = {}): Client {
  return new Client(
    { dsn: DSN, release: '1.0.0', runtime: opts.runtime ?? 'browser' },
    {
      fetchFn: opts.fetchFn ?? mockRawFetch().fn,
      win: opts.win ?? fakeWindow().win,
      doc: opts.doc ?? { visibilityState: 'visible', referrer: '' },
      navigator: opts.navigator ?? fakeNavigator().nav,
      location: opts.location ?? fakeLocation('/').loc,
      ...(opts.timers
        ? { setTimeoutFn: opts.timers.setTimeoutFn, clearTimeoutFn: opts.timers.clearTimeoutFn }
        : {}),
    },
  );
}

interface AutoOpts {
  fetchFn?: ReturnType<typeof mockRawFetch>['fn'];
  win?: ReturnType<typeof fakeWindow>['win'];
  doc?: { visibilityState?: string; referrer?: string };
  navigator?: ReturnType<typeof fakeNavigator>['nav'];
  location?: { pathname?: string };
  history?: {
    pushState: (...args: unknown[]) => unknown;
    replaceState: (...args: unknown[]) => unknown;
  };
  timers?: FakeTimers;
}

function autoClient(opts: AutoOpts = {}): Client {
  return new Client(
    { dsn: DSN, release: '1.0.0', runtime: 'browser', analytics: { auto: true } },
    {
      fetchFn: opts.fetchFn ?? mockRawFetch().fn,
      win: opts.win ?? fakeWindow().win,
      doc: opts.doc ?? { visibilityState: 'visible', referrer: '' },
      navigator: opts.navigator ?? fakeNavigator().nav,
      location: opts.location ?? fakeLocation('/').loc,
      history: opts.history ?? fakeHistory().history,
      ...(opts.timers
        ? { setTimeoutFn: opts.timers.setTimeoutFn, clearTimeoutFn: opts.timers.clearTimeoutFn }
        : {}),
    },
  );
}

describe('analytics batching', () => {
  it('debounces: nothing sends until 5s after the first enqueue, then the whole batch goes in one POST', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const c = manualClient({ fetchFn: f.fn, timers });
    c.trackEvent('signup');
    c.trackEvent('login');
    expect(f.calls).toHaveLength(0);
    expect(timers.pending()).toBe(1); // exactly one debounce timer, not one per event

    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(USAGE_URL);
    expect(f.calls[0]?.init.method).toBe('POST');
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events.map((e) => e.name)).toEqual(['signup', 'login']);
    c.close();
  });

  it('flushes immediately at the 20-event cap, without waiting for the debounce timer', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const c = manualClient({ fetchFn: f.fn, timers });
    for (let i = 0; i < 20; i++) c.trackEvent(`e${String(i)}`);
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(usageBody(f.calls[0]?.init.body).events).toHaveLength(20);
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('flushes the analytics batch via sendBeacon on pagehide, as one POST with { events }', async () => {
    const w = fakeWindow();
    const beacon = fakeNavigator({ beaconOk: true });
    const c = manualClient({ win: w.win, navigator: beacon.nav });
    c.install();
    c.trackEvent('clicked_cta');
    expect(c.analyticsSize()).toBe(1);

    w.dispatch('pagehide', {});
    expect(beacon.beaconCalls).toHaveLength(1);
    expect(beacon.beaconCalls[0]?.url).toBe(USAGE_URL);
    expect(c.analyticsSize()).toBe(0);

    const data = beacon.beaconCalls[0]?.data as { text?: () => Promise<string> } | string;
    const text =
      typeof data === 'string' ? data : await (data as { text: () => Promise<string> }).text();
    const parsed = usageBody(text);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.name).toBe('clicked_cta');
    c.close();
  });

  it('beacons analytics only when visibilityState is hidden', () => {
    const w = fakeWindow();
    const beacon = fakeNavigator({ beaconOk: true });
    const doc = { visibilityState: 'visible', referrer: '' };
    const c = manualClient({ win: w.win, navigator: beacon.nav, doc });
    c.install();
    c.trackEvent('x');

    w.dispatch('visibilitychange', {});
    expect(beacon.beaconCalls).toHaveLength(0);

    doc.visibilityState = 'hidden';
    w.dispatch('visibilitychange', {});
    expect(beacon.beaconCalls).toHaveLength(1);
    c.close();
  });

  it('flush()/close() also flush pending analytics', async () => {
    const f = mockRawFetch();
    const c = manualClient({ fetchFn: f.fn });
    c.trackEvent('a');
    c.trackEvent('b');
    await c.flush();
    expect(f.calls).toHaveLength(1);
    expect(usageBody(f.calls[0]?.init.body).events).toHaveLength(2);
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });
});

describe('auto-mode SPA analytics', () => {
  it('sends an initial pageview on install using location.pathname', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const loc = fakeLocation('/home');
    const c = autoClient({ fetchFn: f.fn, timers, location: loc.loc });
    c.install();
    expect(c.analyticsSize()).toBe(1);

    timers.fireAll();
    await tick();
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events[0]).toMatchObject({ type: 'pageview', path: '/home' });
    c.close();
  });

  it('wraps pushState/replaceState (calling the original through) and tracks SPA navigation', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const loc = fakeLocation('/a');
    const hist = fakeHistory();
    const c = autoClient({ fetchFn: f.fn, timers, location: loc.loc, history: hist.history });
    c.install();
    expect(c.analyticsSize()).toBe(1); // initial pageview

    loc.setPath('/b');
    hist.history.pushState({}, '', '/b');
    expect(hist.pushCalls).toHaveLength(1); // called through
    expect(c.analyticsSize()).toBe(2);

    loc.setPath('/c');
    hist.history.replaceState({}, '', '/c');
    expect(hist.replaceCalls).toHaveLength(1);
    expect(c.analyticsSize()).toBe(3);

    timers.fireAll();
    await tick();
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events.map((e) => e.path)).toEqual(['/a', '/b', '/c']);
    c.close();
  });

  it('tracks popstate navigation', () => {
    const w = fakeWindow();
    const loc = fakeLocation('/x');
    const c = autoClient({ win: w.win, location: loc.loc });
    c.install();
    expect(c.analyticsSize()).toBe(1);

    loc.setPath('/y');
    w.dispatch('popstate', {});
    expect(c.analyticsSize()).toBe(2);
    c.close();
  });

  it('de-dupes consecutive identical paths from repeated SPA navigation', () => {
    const w = fakeWindow();
    const loc = fakeLocation('/same');
    const hist = fakeHistory();
    const c = autoClient({ win: w.win, location: loc.loc, history: hist.history });
    c.install();
    expect(c.analyticsSize()).toBe(1); // initial

    hist.history.pushState({}, '', '/same'); // pathname unchanged
    expect(c.analyticsSize()).toBe(1); // deduped

    w.dispatch('popstate', {}); // still /same
    expect(c.analyticsSize()).toBe(1);

    loc.setPath('/different');
    hist.history.pushState({}, '', '/different');
    expect(c.analyticsSize()).toBe(2);
    c.close();
  });

  it('never breaks pushState even when the original throws: it rethrows, and still tracks', () => {
    const loc = fakeLocation('/a');
    const hist = fakeHistory({ throwOnPush: true });
    const c = autoClient({ location: loc.loc, history: hist.history });
    c.install();
    expect(c.analyticsSize()).toBe(1); // initial pageview

    loc.setPath('/b');
    expect(() => hist.history.pushState({}, '', '/b')).toThrow('pushState boom');
    expect(hist.pushCalls).toHaveLength(1); // still called through
    expect(c.analyticsSize()).toBe(2); // still tracked despite the throw
    c.close();
  });

  it('restores the original pushState/replaceState and removes the popstate listener on close()', () => {
    const w = fakeWindow();
    const loc = fakeLocation('/a');
    const hist = fakeHistory();
    const originalPush = hist.history.pushState;
    const originalReplace = hist.history.replaceState;
    const c = autoClient({ win: w.win, location: loc.loc, history: hist.history });
    c.install();
    expect(hist.history.pushState).not.toBe(originalPush);
    expect(hist.history.replaceState).not.toBe(originalReplace);
    expect(w.count('popstate')).toBe(1);

    c.close();
    expect(hist.history.pushState).toBe(originalPush);
    expect(hist.history.replaceState).toBe(originalReplace);
    expect(w.count('popstate')).toBe(0);
  });

  it('does nothing when analytics.auto is not set (no initial pageview, no hooks)', () => {
    const w = fakeWindow();
    const c = manualClient({ win: w.win }); // manualClient() omits analytics.auto entirely
    c.install();
    expect(c.analyticsSize()).toBe(0);
    expect(w.count('popstate')).toBe(0);
    c.close();
  });
});

describe('pageview referrer', () => {
  it('includes document.referrer only on the first pageview after init; later ones omit it', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const doc = { visibilityState: 'visible', referrer: 'https://google.com/search' };
    const c = manualClient({ fetchFn: f.fn, timers, doc });
    c.trackPageview('/one');
    c.trackPageview('/two');
    timers.fireAll();
    await tick();
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events[0]).toMatchObject({ path: '/one', referrer: 'https://google.com/search' });
    expect(body.events[1]?.referrer).toBeUndefined();
    c.close();
  });

  it('auto mode: the initial pageview carries the referrer; SPA navigations do not', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const loc = fakeLocation('/a');
    const hist = fakeHistory();
    const doc = { visibilityState: 'visible', referrer: 'https://ref.example.com' };
    const c = autoClient({ fetchFn: f.fn, timers, location: loc.loc, history: hist.history, doc });
    c.install();
    loc.setPath('/b');
    hist.history.pushState({}, '', '/b');
    timers.fireAll();
    await tick();
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events[0]).toMatchObject({ path: '/a', referrer: 'https://ref.example.com' });
    expect(body.events[1]?.referrer).toBeUndefined();
    c.close();
  });
});

describe('node runtime analytics', () => {
  it('trackEvent works on node and posts to the usage endpoint', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const c = manualClient({ runtime: 'node', fetchFn: f.fn, timers });
    c.trackEvent('server_job_ran', { ok: true, durationMs: 120 });
    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(USAGE_URL);
    const body = usageBody(f.calls[0]?.init.body);
    expect(body.events[0]).toMatchObject({
      type: 'event',
      name: 'server_job_ran',
      props: { ok: true, durationMs: 120 },
    });
    c.close();
  });

  it('trackPageview is always dropped on node, even with an explicit path', async () => {
    const f = mockRawFetch();
    const timers = fakeTimers();
    const c = manualClient({ runtime: 'node', fetchFn: f.fn, timers });
    expect(() => {
      c.trackPageview('/explicit');
    }).not.toThrow();
    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(0);
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });
});

describe('client-side validation (mirrors the server; drops the whole event, never throws)', () => {
  it.each(['has space', '', 'a'.repeat(65), 'émoji-\u{1F525}', 'has.dot'])(
    'drops an invalid event name (%s)',
    (name) => {
      const c = manualClient();
      expect(() => {
        c.trackEvent(name);
      }).not.toThrow();
      expect(c.analyticsSize()).toBe(0);
      c.close();
    },
  );

  it('accepts letters of both cases, digits, underscore, and hyphen, up to 64 chars', () => {
    const c = manualClient();
    const name = 'a1-_'.repeat(17).slice(0, 64);
    c.trackEvent(name);
    expect(name).toHaveLength(64);
    expect(c.analyticsSize()).toBe(1);
    c.close();
  });

  it('drops when props has more than 10 keys', () => {
    const c = manualClient();
    const props: Record<string, string> = {};
    for (let i = 0; i < 11; i++) props[`k${String(i)}`] = 'v';
    c.trackEvent('ok_name', props);
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('accepts exactly 10 props', () => {
    const c = manualClient();
    const props: Record<string, string> = {};
    for (let i = 0; i < 10; i++) props[`k${String(i)}`] = 'v';
    c.trackEvent('ok_name', props);
    expect(c.analyticsSize()).toBe(1);
    c.close();
  });

  it('drops when a prop key exceeds 64 chars', () => {
    const c = manualClient();
    c.trackEvent('ok_name', { ['k'.repeat(65)]: 'v' });
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('drops when a string prop value exceeds 256 chars', () => {
    const c = manualClient();
    c.trackEvent('ok_name', { big: 'x'.repeat(257) });
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('accepts string/number/boolean prop values at their caps', () => {
    const c = manualClient();
    c.trackEvent('ok_name', { s: 'x'.repeat(256), n: 42, b: true });
    expect(c.analyticsSize()).toBe(1);
    c.close();
  });

  it('drops a non-finite number prop value', () => {
    const c = manualClient();
    c.trackEvent('ok_name', { n: Number.POSITIVE_INFINITY });
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('drops an unsupported prop value type', () => {
    const c = manualClient();
    const badProps = { bad: { nested: true } } as unknown as Record<
      string,
      string | number | boolean
    >;
    expect(() => {
      c.trackEvent('ok_name', badProps);
    }).not.toThrow();
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('drops a pageview with no path available (no location, no explicit path)', () => {
    const c = manualClient({ location: {} });
    c.trackPageview();
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('drops a pageview whose resolved path exceeds 512 chars', () => {
    const c = manualClient();
    c.trackPageview('/'.repeat(513));
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });

  it('omits (but keeps) the pageview when referrer exceeds 512 chars', () => {
    const doc = { visibilityState: 'visible', referrer: 'https://example.com/' + 'x'.repeat(520) };
    const c = manualClient({ doc });
    c.trackPageview('/ok');
    expect(c.analyticsSize()).toBe(1);
    c.close();
  });

  it('is a silent no-op with no dsn (never throws)', async () => {
    const f = mockRawFetch();
    const c = new Client({ release: '1.0.0' }, { fetchFn: f.fn });
    expect(() => {
      c.trackEvent('x');
      c.trackPageview('/x');
    }).not.toThrow();
    await c.flush();
    expect(f.calls).toHaveLength(0);
    c.close();
  });

  it('is a no-op after close()', () => {
    const c = manualClient();
    c.close();
    expect(() => {
      c.trackEvent('x');
      c.trackPageview('/x');
    }).not.toThrow();
    expect(c.analyticsSize()).toBe(0);
  });
});

describe('lossy: no retry, no spool on a failed analytics send', () => {
  it('drops the batch on a network error and never resends it', async () => {
    const f = mockRawFetch([{ reject: true }, {}]);
    const timers = fakeTimers();
    const c = manualClient({ fetchFn: f.fn, timers });
    c.trackEvent('will_be_lost');
    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(1); // one attempt only
    expect(c.analyticsSize()).toBe(0); // gone regardless of outcome

    c.trackEvent('next_one');
    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(2);
    const body = usageBody(f.calls[1]?.init.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.name).toBe('next_one'); // the lost batch is not resent alongside it
    c.close();
  });

  it('drops the batch on a non-2xx response and never resends it', async () => {
    const f = mockRawFetch([{ ok: false, status: 500 }]);
    const timers = fakeTimers();
    const c = manualClient({ fetchFn: f.fn, timers });
    c.trackEvent('server_500');
    timers.fireAll();
    await tick();
    expect(f.calls).toHaveLength(1);
    expect(c.analyticsSize()).toBe(0);
    c.close();
  });
});

describe('never throws, even with a broken transport', () => {
  it('never throws when fetch throws synchronously', async () => {
    const throwingFetch = (): Promise<{ ok: boolean; status: number }> => {
      throw new Error('boom, synchronously');
    };
    const timers = fakeTimers();
    const c = manualClient({ fetchFn: throwingFetch, timers });
    expect(() => {
      c.trackEvent('x');
    }).not.toThrow();
    expect(() => {
      timers.fireAll();
    }).not.toThrow();
    await tick();
    c.close();
  });

  it('never throws when history is missing pushState/replaceState', () => {
    const brokenHistory = {} as unknown as {
      pushState: (...a: unknown[]) => unknown;
      replaceState: (...a: unknown[]) => unknown;
    };
    expect(() => {
      const c = autoClient({ history: brokenHistory });
      c.install();
      c.close();
    }).not.toThrow();
  });

  it('functional API trackPageview/trackEvent never throw before init', () => {
    expect(() => {
      trackPageview('/x');
      trackEvent('y');
    }).not.toThrow();
    close();
  });
});
