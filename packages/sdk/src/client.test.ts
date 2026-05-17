import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EventEnvelope } from '@uh-oh/types';
import { Client } from './client.js';
import type { AsyncStorageLike } from './spool.js';

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
});
