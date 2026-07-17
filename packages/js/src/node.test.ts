import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import { Client } from './uh-oh-client.js';
import { fakeProcess, mockFetch, type FetchInitShape } from './test-support.js';

const DSN = 'https://pk@errors.example.com';

describe('node handlers', () => {
  it('installs uncaughtException + unhandledRejection listeners', () => {
    const p = fakeProcess();
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: mockFetch().fn, proc: p.proc });
    c.install();
    expect(p.listenerCount('uncaughtException')).toBe(1);
    expect(p.listenerCount('unhandledRejection')).toBe(1);
    c.close();
  });

  it('captures an uncaughtException and, as the only listener, flushes then exits(1)', async () => {
    const f = mockFetch();
    const p = fakeProcess(); // no pre-existing uncaughtException listeners
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: f.fn, proc: p.proc });
    c.install();

    await p.trigger('uncaughtException', new Error('fatal'));

    expect(f.calls).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    expect(env.platform).toBe('node');
    expect(env.exception.mechanism).toBe('js-global');
    expect(p.exitCalls).toEqual([1]);
    expect(p.stderrWrites).toHaveLength(1);
    c.close();
  });

  it('does NOT exit when other uncaughtException listeners exist (never steals the decision)', async () => {
    const f = mockFetch();
    const p = fakeProcess({ existingUncaught: 1 });
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: f.fn, proc: p.proc });
    c.install();

    await p.trigger('uncaughtException', new Error('fatal'));

    expect(f.calls).toHaveLength(1); // still captured
    expect(p.exitCalls).toEqual([]); // but did not exit
    c.close();
  });

  it('exits(1) even when the flush cannot complete within the bounded window', async () => {
    const p = fakeProcess();
    const neverFetch = (
      _url: string,
      _init: FetchInitShape,
    ): Promise<{ ok: boolean; status: number }> => new Promise(() => undefined);
    // A setTimeout stub that fires immediately makes the flush window elapse
    // deterministically without a real 2s wait.
    const fireNow = (cb: () => void): unknown => {
      cb();
      return 0;
    };
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      {
        fetchFn: neverFetch,
        proc: p.proc,
        setTimeoutFn: fireNow,
        clearTimeoutFn: () => undefined,
      },
    );
    c.install();

    await p.trigger('uncaughtException', new Error('fatal'));

    expect(p.exitCalls).toEqual([1]);
    c.close();
  });

  it('captures an unhandledRejection with mechanism js-promise and does not exit', async () => {
    const f = mockFetch();
    const p = fakeProcess();
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: f.fn, proc: p.proc });
    c.install();

    await p.trigger('unhandledRejection', new Error('rejected'));
    await c.flush();

    expect(f.calls).toHaveLength(1);
    expect(EventEnvelopeSchema.parse(f.calls[0]?.env).exception.mechanism).toBe('js-promise');
    expect(p.exitCalls).toEqual([]);
    c.close();
  });
});
