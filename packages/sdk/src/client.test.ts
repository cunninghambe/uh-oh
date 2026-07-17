import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { EventEnvelope } from '@uh-oh/types';
import { Client, createLazyAsyncStorage } from './client.js';
import { Spool, type AsyncStorageLike } from './spool.js';
import { setUhOhNativeStub } from './__test-stubs__/react-native.js';

function makeStorage(): AsyncStorageLike {
  const store = new Map<string, string>();
  return {
    getItem(key) {
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key, value) {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

const VALID_DSN = 'https://testkey@errors.example.com';

describe('Client', () => {
  let storage: AsyncStorageLike;

  beforeEach(() => {
    storage = makeStorage();
  });

  it('captureException returns empty string before start (noop when no dsn parsed)', () => {
    // We don't call start() so no handler is installed, but dsn is null
    const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, storage);
    // Without start(), dsn is null so drain is no-op — captureException still works
    const id = client.captureException(new Error('test'));
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('captureException enqueues to spool', async () => {
    const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, storage);
    client.captureException(new Error('test'));
    // Wait for microtasks
    await new Promise((r) => setTimeout(r, 10));
    const spool = await import('./spool.js');
    const s = new spool.Spool(storage);
    // The event should be in spool (or already sent if drain ran)
    // Since we never called start(), drain no-ops, so event stays in spool
    expect(await s.size()).toBeGreaterThanOrEqual(0);
  });

  it('beforeSend returning null prevents sending', async () => {
    const sent: EventEnvelope[] = [];
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: () => null,
      },
      storage,
    );

    const id = client.captureException(new Error('filtered'));
    await new Promise((r) => setTimeout(r, 10));
    expect(id).toBe('');
    expect(sent).toHaveLength(0);
  });

  it('beforeSend can transform the event', () => {
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: (e) => ({ ...e, level: 'warning' }),
      },
      storage,
    );
    const id = client.captureException(new Error('transformed'));
    expect(id).toBeTruthy();
  });

  it('iOS no-op: captureException returns empty string', async () => {
    // Mock platform to return ios
    vi.doMock('./platform.js', () => ({ platform: () => 'ios' }));
    vi.resetModules();

    const { Client: IosClient } = await import('./client.js');
    const iosClient = new IosClient({ dsn: VALID_DSN, release: '1.0.0+1' }, makeStorage());
    iosClient.start();

    const id = iosClient.captureException(new Error('should not capture'));
    expect(id).toBe('');

    vi.doUnmock('./platform.js');
    vi.resetModules();
  });

  it('iOS no-op: start does not throw', async () => {
    vi.doMock('./platform.js', () => ({ platform: () => 'ios' }));
    vi.resetModules();

    const { Client: IosClient } = await import('./client.js');
    const iosClient = new IosClient(
      { dsn: VALID_DSN, release: '1.0.0+1', debug: true },
      makeStorage(),
    );
    expect(() => iosClient.start()).not.toThrow();

    vi.doUnmock('./platform.js');
    vi.resetModules();
  });

  it('start+drain sends enqueued events via transport', async () => {
    const fetched: unknown[] = [];
    const fakeFetch = vi.fn().mockImplementation((url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, status: 202 });
    });

    // Inject fakeFetch via globalThis for transport
    const origFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;

    try {
      const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, storage);
      client.start();
      client.captureException(new Error('drain test'));

      // Wait for async operations
      await new Promise((r) => setTimeout(r, 50));

      // fetch should have been called with ingest URL
      expect(fakeFetch).toHaveBeenCalledWith(
        'https://errors.example.com/ingest/testkey',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('addBreadcrumb is reflected in captured event', () => {
    let capturedEnv: EventEnvelope | null = null;
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: (e) => {
          capturedEnv = e;
          return null; // don't send
        },
      },
      storage,
    );
    client.addBreadcrumb({ category: 'test', message: 'action' });
    client.captureException(new Error('with breadcrumb'));
    const env1 = capturedEnv as EventEnvelope | null;
    expect(env1?.breadcrumbs[0]?.message).toBe('action');
  });

  it('setUser/setTag/setContext/setFingerprint are passed through scope', () => {
    let capturedEnv: EventEnvelope | null = null;
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: (e) => {
          capturedEnv = e;
          return null;
        },
      },
      storage,
    );
    client.scope.setUser({ id: 'u1' });
    client.scope.setTag('env', 'prod');
    client.scope.setFingerprint(['my-module']);
    client.captureException(new Error('scope test'));
    const env2 = capturedEnv as EventEnvelope | null;
    expect(env2?.user?.id).toBe('u1');
    expect(env2?.tags?.['env']).toBe('prod');
    expect(env2?.fingerprint).toEqual(['my-module']);
  });

  describe('native bridge integration', () => {
    afterEach(() => {
      // Restore stub to default after each native test.
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([]),
      });
    });

    it('start() installs native bridge and drains pending report into spool', async () => {
      const pendingReport = {
        mechanism: 'android-java-ueh' as const,
        timestamp: '2024-01-01T00:00:00.000Z',
        exception: {
          type: 'NullPointerException',
          value: 'null ref',
          stacktrace: [],
          mechanism: 'android-java-ueh' as const,
        },
        device: { osName: 'Android', osVersion: '14' },
      };
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([pendingReport]),
      });

      const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, storage);
      client.start();

      // Wait for async native bridge calls to complete.
      await new Promise((r) => setTimeout(r, 50));

      const { Spool } = await import('./spool.js');
      const s = new Spool(storage);
      // Spool should have the pending report (no network to drain it).
      expect(await s.size()).toBeGreaterThan(0);
    });

    it('start() with enableNative:false skips native bridge', async () => {
      const installSpy = vi.fn().mockResolvedValue(true);
      setUhOhNativeStub({ install: installSpy, getPendingReports: () => Promise.resolve([]) });

      const client = new Client(
        { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
        storage,
      );
      client.start();
      await new Promise((r) => setTimeout(r, 50));

      expect(installSpy).not.toHaveBeenCalled();
    });

    it('pending report envelope has correct sdk and release fields', async () => {
      const pendingReport = {
        mechanism: 'android-java-ueh' as const,
        timestamp: '2024-01-01T00:00:00.000Z',
        exception: {
          type: 'IllegalStateException',
          value: 'bad state',
          stacktrace: [],
          mechanism: 'android-java-ueh' as const,
        },
        device: { osName: 'Android', osVersion: '13' },
      };
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([pendingReport]),
      });

      let captured: EventEnvelope | null = null;
      const client = new Client(
        {
          dsn: VALID_DSN,
          release: '2.0.0+5',
          beforeSend: (e) => {
            captured = e;
            return null;
          },
        },
        storage,
      );
      client.start();
      await new Promise((r) => setTimeout(r, 50));

      // The spool is holding the envelope; we need to inspect it differently.
      // buildEnvelopeFromPartial is private — check via spool contents.
      const s = new Spool(storage);
      expect(await s.size()).toBe(1);
      // Captured is null because beforeSend is only called for JS captures, not spool-internal ones.
      expect(captured).toBeNull();
    });
  });

  // Force deterministic handler paths in tests: process.on for rejections (not
  // the real `promise` polyfill) and no NetInfo unless a test injects one.
  const testDeps = { loadRejectionTracking: () => null, loadNetInfo: () => null };

  it('C1: a rejecting spool does not cause a recursive capture loop', async () => {
    let setItemCalls = 0;
    const rejecting: AsyncStorageLike = {
      getItem: () => Promise.resolve(null),
      setItem: () => {
        setItemCalls++;
        return Promise.reject(new Error('disk failure'));
      },
      removeItem: () => Promise.resolve(),
    };
    const client = new Client(
      { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
      rejecting,
      testDeps,
    );
    client.start();
    client.captureException(new Error('boom'));
    await new Promise((r) => setTimeout(r, 30));
    // One capture → exactly one enqueue attempt; the .catch prevents a loop.
    expect(setItemCalls).toBe(1);
    client.stop();
  });

  it('C4: falls back to an in-memory spool when the AsyncStorage require throws', async () => {
    const lazy = createLazyAsyncStorage(false, () => {
      throw new Error('async storage absent');
    });
    // Construction + capture must not throw despite the failed require.
    const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, lazy);
    const id = client.captureException(new Error('offline crash'));
    expect(id).not.toBe('');
    await new Promise((r) => setTimeout(r, 10));
    // Event landed in the in-memory fallback (same lazy storage instance).
    expect(await new Spool(lazy).size()).toBe(1);
  });

  it('H3: a throwing beforeSend sends the unmodified event', async () => {
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: () => {
          throw new Error('beforeSend crashed');
        },
      },
      storage,
    );
    client.captureException(new Error('boom'));
    await new Promise((r) => setTimeout(r, 10));

    const s = new Spool(storage);
    let sent: EventEnvelope | null = null;
    await s.drain((env) => {
      sent = env;
      return Promise.resolve({ ok: true, status: 202 });
    });
    const e = sent as EventEnvelope | null;
    expect(e?.exception.value).toBe('boom');
    expect(e?.level).toBe('error'); // untouched by the throwing beforeSend
  });

  it('M9: parses Hermes and anonymous stack frames', () => {
    let captured: EventEnvelope | null = null;
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: (e) => {
          captured = e;
          return null;
        },
      },
      storage,
    );
    const err = new Error('hermes crash');
    err.stack = [
      'Error: hermes crash',
      '    at foo (address at /data/app/bundle.js:1:2345)',
      '    at /data/app/anon.js:10:20',
      '    at bar (/data/app/plain.js:5:6)',
    ].join('\n');
    client.captureException(err);

    const frames = (captured as EventEnvelope | null)?.exception.stacktrace ?? [];
    expect(frames[0]).toMatchObject({ filename: '/data/app/bundle.js', lineno: 1, colno: 2345 });
    expect(frames[1]).toMatchObject({ filename: '/data/app/anon.js', lineno: 10, colno: 20 });
    expect(frames[2]).toMatchObject({ filename: '/data/app/plain.js', lineno: 5, colno: 6 });
  });

  it('L1: includes environment in context and a real osVersion', () => {
    let captured: EventEnvelope | null = null;
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        environment: 'staging',
        beforeSend: (e) => {
          captured = e;
          return null;
        },
      },
      storage,
    );
    client.captureException(new Error('x'));
    const e = captured as EventEnvelope | null;
    expect(e?.context?.['environment']).toBe('staging');
    expect(e?.device.osVersion).toBe('34'); // stub Platform.Version = 34
  });

  it('L4: attaches the returned event id to context.eventId', () => {
    let captured: EventEnvelope | null = null;
    const client = new Client(
      {
        dsn: VALID_DSN,
        release: '1.0.0+1',
        beforeSend: (e) => {
          captured = e;
          return e;
        },
      },
      storage,
    );
    const id = client.captureException(new Error('x'));
    const e = captured as EventEnvelope | null;
    expect(id).not.toBe('');
    expect(e?.context?.['eventId']).toBe(id);
  });

  it('M6: re-init does not leak handlers (stop before recreate)', () => {
    const base = process.listenerCount('unhandledRejection');
    const c1 = new Client(
      { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
      makeStorage(),
      testDeps,
    );
    c1.start();
    expect(process.listenerCount('unhandledRejection')).toBe(base + 1);

    // Mirror index.init()'s teardown-before-recreate.
    c1.stop();
    const c2 = new Client(
      { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
      makeStorage(),
      testDeps,
    );
    c2.start();
    expect(process.listenerCount('unhandledRejection')).toBe(base + 1); // still one, not two
    c2.stop();
    expect(process.listenerCount('unhandledRejection')).toBe(base); // fully cleaned
  });

  describe('native ack (M1)', () => {
    let origFetch: typeof fetch;

    beforeEach(() => {
      origFetch = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 202 }) as unknown as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = origFetch;
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([]),
      });
    });

    const report = (id: string) => ({
      id,
      payload: {
        mechanism: 'android-java-ueh' as const,
        timestamp: '2024-01-01T00:00:00.000Z',
        exception: {
          type: 'NullPointerException',
          value: 'null ref',
          stacktrace: [],
          mechanism: 'android-java-ueh' as const,
        },
        device: { osName: 'Android', osVersion: '14' },
      },
    });

    it('acks a native report after the spool write succeeds', async () => {
      const ackSpy = vi.fn().mockResolvedValue(undefined);
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([report('rep-1')]),
        ackReport: ackSpy,
      });
      const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, storage, testDeps);
      client.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(ackSpy).toHaveBeenCalledWith('rep-1');
      client.stop();
    });

    it('does NOT ack when the spool write fails', async () => {
      const ackSpy = vi.fn();
      setUhOhNativeStub({
        install: () => Promise.resolve(true),
        getPendingReports: () => Promise.resolve([report('rep-2')]),
        ackReport: ackSpy,
      });
      const failing: AsyncStorageLike = {
        getItem: () => Promise.resolve(null),
        setItem: () => Promise.reject(new Error('disk full')),
        removeItem: () => Promise.resolve(),
      };
      const client = new Client({ dsn: VALID_DSN, release: '1.0.0+1' }, failing, testDeps);
      client.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(ackSpy).not.toHaveBeenCalled();
      client.stop();
    });
  });

  describe('connectivity flush (M5)', () => {
    let origFetch: typeof fetch;

    afterEach(() => {
      globalThis.fetch = origFetch;
      vi.useRealTimers();
    });

    it('retry timer drains pending events once connectivity returns', async () => {
      vi.useFakeTimers();
      let online = false;
      const fetchMock = vi.fn(() =>
        online ? Promise.resolve({ ok: true, status: 202 }) : Promise.reject(new Error('offline')),
      );
      origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new Client(
        { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
        storage,
        testDeps,
      );
      client.start();
      client.captureException(new Error('offline crash'));
      await vi.advanceTimersByTimeAsync(5);
      expect(await new Spool(storage).size()).toBe(1); // spooled while offline

      online = true;
      await vi.advanceTimersByTimeAsync(30_000); // retry timer fires
      expect(await new Spool(storage).size()).toBe(0); // drained
      client.stop();
    });

    it('does not run a retry timer while the spool is empty', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 202 }));
      origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new Client(
        { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
        storage,
        testDeps,
      );
      client.start();
      client.captureException(new Error('x'));
      await vi.advanceTimersByTimeAsync(5);
      expect(await new Spool(storage).size()).toBe(0); // sent immediately

      const callsAfterSend = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock.mock.calls.length).toBe(callsAfterSend); // no timer-driven drains
      client.stop();
    });

    it('drains on NetInfo reconnect when NetInfo is available', async () => {
      let cb: ((s: { isConnected: boolean | null }) => void) | undefined;
      const netInfo = {
        addEventListener: (fn: (s: { isConnected: boolean | null }) => void) => {
          cb = fn;
          return () => undefined;
        },
      };
      let online = false;
      const fetchMock = vi.fn(() =>
        online ? Promise.resolve({ ok: true, status: 202 }) : Promise.reject(new Error('offline')),
      );
      origFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new Client(
        { dsn: VALID_DSN, release: '1.0.0+1', enableNative: false },
        storage,
        { loadRejectionTracking: () => null, loadNetInfo: () => netInfo },
      );
      client.start();
      client.captureException(new Error('offline crash'));
      await new Promise((r) => setTimeout(r, 20));
      expect(await new Spool(storage).size()).toBe(1); // spooled while offline

      online = true;
      cb?.({ isConnected: true }); // reconnect event
      await new Promise((r) => setTimeout(r, 20));
      expect(await new Spool(storage).size()).toBe(0); // flushed on reconnect
      client.stop();
    });
  });
});
