import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import { Client } from './uh-oh-client.js';
import { fakeNavigator, fakeStorage, fakeWindow, mockFetch, mockRawFetch } from './test-support.js';

const DSN = 'https://pk@errors.example.com';
const SPOOL_KEY = 'uh-oh:spool';

interface BrowserOpts {
  fetchFn?: ReturnType<typeof mockFetch>['fn'];
  win?: ReturnType<typeof fakeWindow>['win'];
  doc?: { visibilityState: string };
  navigator?: ReturnType<typeof fakeNavigator>['nav'];
  storage?: ReturnType<typeof fakeStorage>['storage'];
}

function browserClient(opts: BrowserOpts) {
  return new Client(
    { dsn: DSN, release: '1.0.0' },
    {
      fetchFn: opts.fetchFn ?? mockFetch().fn,
      win: opts.win ?? fakeWindow().win,
      doc: opts.doc ?? { visibilityState: 'visible' },
      navigator: opts.navigator ?? fakeNavigator().nav,
      storage: opts.storage ?? fakeStorage().storage,
    },
  );
}

describe('browser handlers', () => {
  it('captures window "error" events with mechanism js-global (platform web)', async () => {
    const w = fakeWindow();
    const f = mockFetch();
    const c = browserClient({ fetchFn: f.fn, win: w.win });
    c.install();
    expect(w.count('error')).toBe(1);
    expect(w.count('unhandledrejection')).toBe(1);

    let prevented = false;
    w.dispatch('error', {
      error: new Error('boom'),
      message: 'boom',
      preventDefault: () => {
        prevented = true;
      },
    });
    await c.flush();

    expect(prevented).toBe(false); // must never preventDefault
    expect(f.calls).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.platform).toBe('web');
    expect(env.exception.mechanism).toBe('js-global');
    c.close();
  });

  it('captures unhandledrejection with mechanism js-promise', async () => {
    const w = fakeWindow();
    const f = mockFetch();
    const c = browserClient({ fetchFn: f.fn, win: w.win });
    c.install();
    w.dispatch('unhandledrejection', { reason: new Error('rejected') });
    await c.flush();
    expect(EventEnvelopeSchema.parse(f.calls[0]?.env).exception.mechanism).toBe('js-promise');
    c.close();
  });

  it('derives device info from the user agent (macOS + locale + timezone)', async () => {
    const f = mockFetch();
    const nav = fakeNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      language: 'fr-FR',
    }).nav;
    const c = browserClient({ fetchFn: f.fn, navigator: nav });
    c.captureException(new Error('x'));
    await c.flush();
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.device.osName).toBe('macOS');
    expect(env.device.osVersion).toBe('10.15.7');
    expect(env.device.locale).toBe('fr-FR');
    expect(typeof env.device.timezone).toBe('string');
    c.close();
  });

  it('sends with keepalive:true in the browser', async () => {
    const f = mockFetch();
    const c = browserClient({ fetchFn: f.fn });
    c.captureException(new Error('x'));
    await c.flush();
    expect(f.calls[0]?.init.keepalive).toBe(true);
    c.close();
  });
});

describe('browser checkIn', () => {
  it('posts to the check-in url with keepalive:true and method POST', async () => {
    const f = mockRawFetch();
    const c = browserClient({ fetchFn: f.fn });
    c.checkIn('nightly-backup', { intervalMinutes: 15 });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      'https://errors.example.com/ingest/pk/check-in/nightly-backup?intervalMinutes=15',
    );
    expect(f.calls[0]?.init.method).toBe('POST');
    expect(f.calls[0]?.init.keepalive).toBe(true);
    c.close();
  });
});

describe('browser localStorage persistence', () => {
  it('persists the queue offline and restores it on a fresh client', async () => {
    const store = fakeStorage();
    const offline = mockFetch([{ reject: true }]);
    const c1 = browserClient({ fetchFn: offline.fn, storage: store.storage });
    c1.captureException(new Error('offline crash'));
    await c1.flush();
    expect(store.map.get(SPOOL_KEY)).toBeTruthy();
    expect(c1.size()).toBe(1);
    c1.close();

    // A new client (crash-then-navigate) restores and drains.
    const online = mockFetch();
    const c2 = browserClient({ fetchFn: online.fn, storage: store.storage });
    c2.install();
    await c2.flush();
    expect(online.calls.length).toBeGreaterThanOrEqual(1);
    expect(c2.size()).toBe(0);
    expect(store.map.get(SPOOL_KEY)).toBeFalsy();
    c2.close();
  });

  it('tolerates corrupt spool contents (non-JSON and non-array) without throwing', () => {
    for (const bad of ['not json{', '{"not":"an array"}', 'null', '42']) {
      const store = fakeStorage({ [SPOOL_KEY]: bad });
      const c = browserClient({ storage: store.storage });
      expect(() => {
        c.install();
      }).not.toThrow();
      c.close();
    }
  });

  it('discards malformed entries but keeps well-formed ones on restore', async () => {
    const store = fakeStorage({
      [SPOOL_KEY]: JSON.stringify([1, 'junk', null, { id: 'a', env: { hello: 'x' } }]),
    });
    const offline = mockFetch([{ reject: true }]);
    const c = browserClient({ fetchFn: offline.fn, storage: store.storage });
    c.install();
    await c.flush();
    expect(c.size()).toBe(1);
    c.close();
  });

  it('tolerates a throwing localStorage.getItem', () => {
    const store = fakeStorage();
    store.failGet();
    const c = browserClient({ storage: store.storage });
    expect(() => {
      c.install();
    }).not.toThrow();
    c.close();
  });
});

describe('browser lifecycle flush (sendBeacon)', () => {
  it('flushes pending events via sendBeacon on pagehide', async () => {
    const w = fakeWindow();
    const beacon = fakeNavigator({ beaconOk: true });
    const offline = mockFetch([{ reject: true }]);
    const c = browserClient({ fetchFn: offline.fn, win: w.win, navigator: beacon.nav });
    c.install();
    c.captureException(new Error('x'));
    await c.flush();
    expect(c.size()).toBe(1);

    w.dispatch('pagehide', {});
    expect(beacon.beaconCalls).toHaveLength(1);
    expect(beacon.beaconCalls[0]?.url).toBe('https://errors.example.com/ingest/pk');
    expect(c.size()).toBe(0);
    c.close();
  });

  it('beacons only when visibilityState is hidden', async () => {
    const w = fakeWindow();
    const beacon = fakeNavigator({ beaconOk: true });
    const offline = mockFetch([{ reject: true }, { reject: true }]);
    const doc = { visibilityState: 'visible' };
    const c = browserClient({ fetchFn: offline.fn, win: w.win, navigator: beacon.nav, doc });
    c.install();
    c.captureException(new Error('x'));
    await c.flush();

    w.dispatch('visibilitychange', {});
    expect(beacon.beaconCalls).toHaveLength(0); // still visible

    doc.visibilityState = 'hidden';
    w.dispatch('visibilitychange', {});
    expect(beacon.beaconCalls).toHaveLength(1);
    c.close();
  });
});
