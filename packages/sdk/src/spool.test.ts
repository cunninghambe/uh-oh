import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { EventEnvelope } from '@uh-oh/types';
import { Spool } from './spool.js';
import type { SendResult } from './transport.js';

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

describe('Spool concurrency + robustness', () => {
  let storage: ReturnType<typeof makeStorage>;
  let spool: Spool;

  beforeEach(() => {
    storage = makeStorage();
    spool = new Spool(storage);
  });

  it('H1: preserves events enqueued during a drain (no loss)', async () => {
    await spool.enqueue(minEnv('A'));

    // A send we release manually, so we can enqueue while it's in flight.
    let releaseSend: (r: SendResult) => void = () => undefined;
    const gate = new Promise<SendResult>((res) => {
      releaseSend = res;
    });
    const sent: string[] = [];
    const drainPromise = spool.drain((env) => {
      sent.push(env.release.build);
      return gate;
    });

    // Mid-drain enqueue of B.
    await spool.enqueue(minEnv('B'));
    releaseSend({ ok: true, status: 202 });
    await drainPromise;

    expect(sent).toEqual(['A']); // only the snapshot was sent
    expect(await spool.size()).toBe(1); // B was not lost
  });

  it('H1/L6: concurrent drains coalesce — no overlap, each event sent once', async () => {
    await spool.enqueue(minEnv('A'));
    await spool.enqueue(minEnv('B'));

    let inFlight = 0;
    let maxConcurrent = 0;
    const sent: string[] = [];
    const send = async (env: EventEnvelope): Promise<SendResult> => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      sent.push(env.release.build);
      inFlight--;
      return { ok: true, status: 202 };
    };

    await Promise.all([spool.drain(send), spool.drain(send)]);

    expect(maxConcurrent).toBe(1); // never two drains at once
    expect([...sent].sort()).toEqual(['A', 'B']); // each exactly once
    expect(await spool.size()).toBe(0);
  });

  it('H2: drops a 400 poison event and continues draining', async () => {
    await spool.enqueue(minEnv('bad'));
    await spool.enqueue(minEnv('good'));

    const sent: string[] = [];
    await spool.drain((env) => {
      sent.push(env.release.build);
      return Promise.resolve(
        env.release.build === 'bad' ? { ok: false, status: 400 } : { ok: true, status: 202 },
      );
    });

    expect(sent).toEqual(['bad', 'good']); // did not block on the 400
    expect(await spool.size()).toBe(0); // bad dropped, good sent
  });

  it('H2: retains on 500 and stops draining', async () => {
    await spool.enqueue(minEnv('a'));
    await spool.enqueue(minEnv('b'));

    let calls = 0;
    await spool.drain(() => {
      calls++;
      return Promise.resolve({ ok: false, status: 500 });
    });

    expect(calls).toBe(1); // stopped after first failure
    expect(await spool.size()).toBe(2); // retained
  });

  it('H2: retains on 429 (rate limited) and stops draining', async () => {
    await spool.enqueue(minEnv('a'));
    await spool.enqueue(minEnv('b'));

    let calls = 0;
    await spool.drain(() => {
      calls++;
      return Promise.resolve({ ok: false, status: 429 });
    });

    expect(calls).toBe(1);
    expect(await spool.size()).toBe(2);
  });

  it('M4: 413 then a transient failure keeps the TRIMMED event spooled', async () => {
    const env = minEnv('t');
    env.breadcrumbs = Array.from({ length: 80 }, (_, i) => ({
      category: 'log',
      message: `m${String(i)}`,
      level: 'info' as const,
      ts: '2026-05-16T12:00:00.000Z',
    }));
    await spool.enqueue(env);

    let call = 0;
    const seenLengths: number[] = [];
    await spool.drain((e) => {
      call++;
      seenLengths.push(e.breadcrumbs.length);
      if (call === 1) return Promise.resolve({ ok: false, status: 413 });
      return Promise.resolve({ ok: false, status: 500 }); // transient after trim
    });

    expect(seenLengths).toEqual([80, 50]); // full, then trimmed
    expect(await spool.size()).toBe(1); // kept (not dropped)

    // The retained copy must be the trimmed one (50), not the original (80).
    let nextLen = -1;
    await spool.drain((e) => {
      nextLen = e.breadcrumbs.length;
      return Promise.resolve({ ok: true, status: 202 });
    });
    expect(nextLen).toBe(50);
    expect(await spool.size()).toBe(0);
  });

  it('M7: discards corrupt spool contents ("{}") and still enqueues', async () => {
    storage.store.set('@uh-oh/spool', '{}');
    await spool.enqueue(minEnv('x'));
    expect(await spool.size()).toBe(1);
  });

  it('M7: discards malformed array entries ("[1,2]") and keeps only valid events', async () => {
    storage.store.set('@uh-oh/spool', '[1,2]');
    await spool.enqueue(minEnv('y'));
    expect(await spool.size()).toBe(1); // junk discarded, only y
  });

  it('L3: trims an oversize single event rather than nuking the spool', async () => {
    const big = minEnv('big');
    big.breadcrumbs = Array.from({ length: 1500 }, () => ({
      category: 'log',
      message: 'x'.repeat(1000),
      level: 'info' as const,
      ts: '2026-05-16T12:00:00.000Z',
    }));
    await spool.enqueue(big);
    expect(await spool.size()).toBe(1); // fit after trimming, not dropped

    let sentBreadcrumbs = -1;
    await spool.drain((e) => {
      sentBreadcrumbs = e.breadcrumbs.length;
      return Promise.resolve({ ok: true, status: 202 });
    });
    expect(sentBreadcrumbs).toBe(0); // breadcrumbs trimmed away to fit
  });

  it('L3: drops a single event too large even after trimming', async () => {
    const huge = minEnv('huge');
    huge.exception.value = 'x'.repeat(1_100_000); // >1 MB in the value alone
    await spool.enqueue(huge);
    expect(await spool.size()).toBe(0); // dropped, spool intact

    await spool.enqueue(minEnv('ok')); // normal events still work
    expect(await spool.size()).toBe(1);
  });

  it('L2: logs to debug when dropping events over the cap', async () => {
    const debugSpool = new Spool(storage, true);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    for (let i = 0; i < 101; i++) {
      await debugSpool.enqueue(minEnv(String(i)));
    }
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
