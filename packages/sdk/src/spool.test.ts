import { describe, expect, it, beforeEach } from 'vitest';
import type { EventEnvelope } from '@uh-oh/types';
import { Spool } from './spool.js';

// In-memory AsyncStorage for tests
function makeStorage(): {
  store: Map<string, string>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
} {
  const store = new Map<string, string>();
  return {
    store,
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

const minEnv = (id = '1'): EventEnvelope => ({
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: id },
  level: 'error',
  exception: {
    type: 'Error',
    value: `error ${id}`,
    stacktrace: [{ inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14' },
});

describe('Spool', () => {
  let storage: ReturnType<typeof makeStorage>;
  let spool: Spool;

  beforeEach(() => {
    storage = makeStorage();
    spool = new Spool(storage);
  });

  it('starts empty', async () => {
    expect(await spool.size()).toBe(0);
  });

  it('enqueues and drain sends event', async () => {
    await spool.enqueue(minEnv());
    expect(await spool.size()).toBe(1);

    const sent: EventEnvelope[] = [];
    await spool.drain((env) => {
      sent.push(env);
      return Promise.resolve({ ok: true, status: 202 });
    });

    expect(sent).toHaveLength(1);
    expect(await spool.size()).toBe(0);
  });

  it('drops oldest when over cap (MAX_EVENTS = 100)', async () => {
    // Enqueue 101 events — the first should be dropped
    for (let i = 0; i < 101; i++) {
      await spool.enqueue(minEnv(String(i)));
    }
    expect(await spool.size()).toBe(100);

    let firstBuild = '';
    await spool.drain((env) => {
      if (!firstBuild) firstBuild = env.release.build;
      return Promise.resolve({ ok: true, status: 202 });
    });
    // build '0' was dropped; first should be '1'
    expect(firstBuild).toBe('1');
  });

  it('stops draining on network error and preserves remaining events', async () => {
    await spool.enqueue(minEnv('a'));
    await spool.enqueue(minEnv('b'));
    await spool.enqueue(minEnv('c'));

    let calls = 0;
    await spool.drain(() => {
      calls++;
      return Promise.resolve({ ok: false }); // network error on first call
    });

    expect(calls).toBe(1);
    expect(await spool.size()).toBe(3); // all preserved
  });

  it('413: trims breadcrumbs to last 50 and retries', async () => {
    const env = minEnv('x');
    env.breadcrumbs = Array.from({ length: 80 }, (_, i) => ({
      category: 'log',
      message: `msg ${String(i)}`,
      level: 'info' as const,
      ts: '2026-05-16T12:00:00.000Z',
    }));
    await spool.enqueue(env);

    const sentEnvs: EventEnvelope[] = [];
    let call = 0;
    await spool.drain((e) => {
      sentEnvs.push(e);
      call++;
      if (call === 1) return Promise.resolve({ ok: false, status: 413 });
      return Promise.resolve({ ok: true, status: 202 });
    });

    expect(sentEnvs).toHaveLength(2);
    expect(sentEnvs[1]?.breadcrumbs).toHaveLength(50);
    expect(await spool.size()).toBe(0);
  });

  it('413 on retry: drops event with debug log', async () => {
    const env = minEnv('y');
    env.breadcrumbs = Array.from({ length: 80 }, (_, i) => ({
      category: 'log',
      message: `msg ${String(i)}`,
      level: 'info' as const,
      ts: '2026-05-16T12:00:00.000Z',
    }));
    await spool.enqueue(env);

    let calls = 0;
    await spool.drain(() => {
      calls++;
      return Promise.resolve({ ok: false, status: 413 });
    });

    expect(calls).toBe(2); // initial + one retry
    expect(await spool.size()).toBe(0); // dropped
  });
});
