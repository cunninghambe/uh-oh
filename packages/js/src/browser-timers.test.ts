// Regression: in a real browser, window.setTimeout / setInterval / clearTimeout
// / clearInterval are WebIDL operations that throw "TypeError: Illegal
// invocation" when called with a `this` that is not the window. The client
// stores them as fields and calls `this.setTimeoutFn(...)`, so unless they are
// bound, every send in a browser threw before fetch ran: nothing was ever
// delivered, and the self-captured rejection looped (production issue
// "TypeError: Illegal invocation at window.setInterval [as setIntervalFn]").
// Node's timers ignore `this`, and the other suites inject fakes, so nothing
// caught it. These tests swap in this-strict globals that behave like a
// browser's and build the client WITHOUT injected timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import { Client } from './uh-oh-client.js';
import { fakeNavigator, fakeStorage, fakeWindow, mockFetch, mockRawFetch } from './test-support.js';

const DSN = 'https://pk@errors.example.com';

type AnyFn = (...args: never[]) => unknown;

const TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

/** Wrap a real global so it throws like a browser on a foreign `this`;
 *  records misuse and successful calls by name. */
function thisStrict<F extends AnyFn>(name: string, real: F): F {
  return function (this: unknown, ...args: never[]): unknown {
    if (this !== undefined && this !== globalThis) {
      misuse.push(name);
      throw new TypeError('Illegal invocation');
    }
    used.push(name);
    return real.apply(globalThis, args);
  } as unknown as F;
}

let misuse: string[];
let used: string[];

beforeEach(() => {
  misuse = [];
  used = [];
  for (const name of TIMERS) {
    vi.stubGlobal(name, thisStrict(name, globalThis[name] as unknown as AnyFn));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function browserClient(
  fetchFn: ReturnType<typeof mockFetch>['fn'],
  storage = fakeStorage().storage,
): Client {
  // No setTimeoutFn/setIntervalFn/... deps: the client must use the globals.
  return new Client(
    { dsn: DSN, release: '1.0.0+7' },
    {
      fetchFn,
      win: fakeWindow().win,
      doc: { visibilityState: 'visible' },
      navigator: fakeNavigator().nav,
      storage,
    },
  );
}

describe('browser runtime with this-strict global timers', () => {
  it('the stub really does reject a foreign `this` (guards the test itself)', () => {
    const holder = { t: globalThis.setTimeout };
    expect(() => holder.t(() => undefined, 0)).toThrow('Illegal invocation');
    expect(misuse).toEqual(['setTimeout']);
  });

  it('delivers a captured exception over fetch', async () => {
    const f = mockFetch();
    const c = browserClient(f.fn);
    c.captureException(new Error('boom'));
    await c.flush();
    expect(f.calls).toHaveLength(1);
    expect(EventEnvelopeSchema.parse(f.calls[0]?.env).platform).toBe('web');
    expect(misuse).toEqual([]);
    c.close();
  });

  it('arms and clears the retry interval after a failed send without throwing', async () => {
    const f = mockFetch([{ ok: false, status: 503 }]);
    const c = browserClient(f.fn);
    c.captureException(new Error('server down'));
    await c.flush();
    expect(f.calls.length).toBeGreaterThanOrEqual(1);
    // The 503 leaves the event queued, which arms the retry interval; close()
    // must clear it. Either step threw "Illegal invocation" before the fix.
    expect(used).toContain('setInterval');
    expect(() => c.close()).not.toThrow();
    expect(used).toContain('clearInterval');
    expect(misuse).toEqual([]);
  });

  it('a clean page load delivers the event an earlier page left in the spool', async () => {
    // Before the fix this was the worst case seen in Chrome: no error on the
    // page at all, yet the restored event failed to send, the retry timer
    // threw, and the rejection looped until the spool was full.
    const store = fakeStorage();
    const offline = browserClient(mockFetch([{ reject: true }]).fn, store.storage);
    offline.captureException(new Error('from the last visit'));
    await offline.flush();
    offline.close();
    expect(JSON.parse(store.map.get('uh-oh:spool') ?? '[]')).toHaveLength(1);
    misuse = [];

    const f = mockFetch();
    const c = browserClient(f.fn, store.storage);
    c.install();
    await c.flush();
    expect(f.calls.map((call) => call.env.exception.value)).toEqual(['from the last visit']);
    expect(c.size()).toBe(0);
    expect(store.map.has('uh-oh:spool')).toBe(false);
    expect(misuse).toEqual([]);
    c.close();
  });

  it('schedules and sends a usage batch', async () => {
    const f = mockRawFetch();
    const c = browserClient(f.fn);
    c.trackEvent('signup');
    await c.flush();
    const usage = f.calls.filter((call) => call.url.endsWith('/usage'));
    expect(usage).toHaveLength(1);
    expect(JSON.parse(usage[0]?.init.body ?? '{}')).toMatchObject({
      events: [{ type: 'event', name: 'signup' }],
    });
    expect(misuse).toEqual([]);
    c.close();
  });
});
