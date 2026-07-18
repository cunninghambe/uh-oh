import { afterEach, describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import {
  Client,
  parseDsn,
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  setUser,
  setContext,
  setTag,
  setFingerprint,
  flush,
  close,
} from './uh-oh-client.js';
import { fakeProcess, mockFetch } from './test-support.js';

const DSN = 'https://pubkey123@errors.example.com';
const INGEST = 'https://errors.example.com/ingest/pubkey123';

function firstCallEnv(calls: ReturnType<typeof mockFetch>['calls']) {
  const [call] = calls;
  if (!call) throw new Error('expected at least one fetch call');
  return call.env;
}

describe('parseDsn', () => {
  it('parses host into origin + ingest url', () => {
    expect(parseDsn('https://k@h.example.com')).toEqual({
      publicKey: 'k',
      baseUrl: 'https://h.example.com',
      ingestUrl: 'https://h.example.com/ingest/k',
    });
  });

  it('preserves an explicit port', () => {
    const d = parseDsn('https://k@h.example.com:3300');
    expect(d?.baseUrl).toBe('https://h.example.com:3300');
    expect(d?.ingestUrl).toBe('https://h.example.com:3300/ingest/k');
  });

  it('keeps a path prefix (reverse-proxy subpath), stripping a trailing slash', () => {
    const d = parseDsn('https://k@h.example.com/base/');
    expect(d?.baseUrl).toBe('https://h.example.com/base');
    expect(d?.ingestUrl).toBe('https://h.example.com/base/ingest/k');
  });

  it('allows http', () => {
    expect(parseDsn('http://k@localhost:8080')?.ingestUrl).toBe('http://localhost:8080/ingest/k');
  });

  it('returns null for a missing public key', () => {
    expect(parseDsn('https://h.example.com')).toBeNull();
  });

  it('returns null for empty / undefined', () => {
    expect(parseDsn('')).toBeNull();
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn('   ')).toBeNull();
  });

  it('returns null for a non-URL and a bad scheme', () => {
    expect(parseDsn('not a url')).toBeNull();
    expect(parseDsn('ftp://k@h.example.com')).toBeNull();
  });
});

describe('Client - envelope + runtime', () => {
  it('produces a schema-valid node envelope and posts to the ingest url', async () => {
    const f = mockFetch();
    const p = fakeProcess({ platform: 'linux', version: 'v20.3.1', arch: 'arm64' });
    const c = new Client({ dsn: DSN, release: '1.4.2+37' }, { fetchFn: f.fn, proc: p.proc });
    const id = c.captureException(new Error('boom'));
    await c.flush();
    expect(id).not.toBe('');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(INGEST);
    const env = EventEnvelopeSchema.parse(firstCallEnv(f.calls));
    expect(env.platform).toBe('node');
    expect(env.sdk).toEqual({ name: '@uh-oh/js', version: '0.2.0' });
    expect(env.release).toEqual({ version: '1.4.2', build: '37' });
    expect(env.device.osName).toBe('linux');
    expect(env.device.osVersion).toBe('v20.3.1');
    expect(env.device.arch).toBe('arm64');
    expect(env.exception.mechanism).toBe('js-manual');
    expect(env.context?.['eventId']).toBe(id);
    c.close();
  });

  it('defaults build to "0" when release has no +build', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '2.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('x'));
    await c.flush();
    expect(firstCallEnv(f.calls).release).toEqual({ version: '2.0.0', build: '0' });
    c.close();
  });

  it('honours a runtime override (node globals, forced browser => platform web)', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0', runtime: 'browser' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('x'));
    await c.flush();
    const env = EventEnvelopeSchema.parse(firstCallEnv(f.calls));
    expect(env.platform).toBe('web');
    c.close();
  });

  it('auto-detects node when window/document are absent', async () => {
    const f = mockFetch();
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: f.fn });
    c.captureException(new Error('x'));
    await c.flush();
    expect(firstCallEnv(f.calls).platform).toBe('node');
    c.close();
  });

  it('captureMessage produces a schema-valid envelope', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    const id = c.captureMessage('hello world', 'warning');
    await c.flush();
    const env = EventEnvelopeSchema.parse(firstCallEnv(f.calls));
    expect(env.level).toBe('warning');
    expect(env.exception.type).toBe('Message');
    expect(env.exception.value).toBe('hello world');
    expect(id).not.toBe('');
    c.close();
  });

  it('carries scope (user/tags/context/fingerprint) and environment into the envelope', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0', environment: 'staging' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.setUser({ id: 'u-1', email: 'a@b.com' });
    c.setTag('area', 'checkout');
    c.setContext('cart', { items: 3 });
    c.setFingerprint(['group-a']);
    c.addBreadcrumb({ category: 'nav', message: 'home -> cart' });
    c.captureException(new Error('x'));
    await c.flush();
    const env = EventEnvelopeSchema.parse(firstCallEnv(f.calls));
    expect(env.user).toEqual({ id: 'u-1', email: 'a@b.com' });
    expect(env.tags).toEqual({ area: 'checkout' });
    expect(env.context?.['cart']).toEqual({ items: 3 });
    expect(env.context?.['environment']).toBe('staging');
    expect(env.fingerprint).toEqual(['group-a']);
    expect(env.breadcrumbs).toHaveLength(1);
    c.close();
  });

  it('setTag(null)/setContext(null)/setFingerprint(null) clear scope', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.setTag('a', '1');
    c.setTag('a', null);
    c.setContext('x', { v: 1 });
    c.setContext('x', null);
    c.setFingerprint(['g']);
    c.setFingerprint(null);
    c.captureException(new Error('x'));
    await c.flush();
    const env = firstCallEnv(f.calls);
    expect(env.tags).toBeUndefined();
    expect(env.fingerprint).toBeUndefined();
    expect(env.context?.['x']).toBeUndefined();
    c.close();
  });
});

describe('Client - beforeSend', () => {
  it('drops the event when beforeSend returns null', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0', beforeSend: () => null },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    const id = c.captureException(new Error('x'));
    await c.flush();
    expect(id).toBe('');
    expect(f.calls).toHaveLength(0);
    c.close();
  });

  it('sends the modified event when beforeSend mutates', async () => {
    const f = mockFetch();
    const c = new Client(
      {
        dsn: DSN,
        release: '1.0.0',
        beforeSend: (e) => ({ ...e, tags: { ...(e.tags ?? {}), scrubbed: 'yes' } }),
      },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('x'));
    await c.flush();
    expect(firstCallEnv(f.calls).tags?.['scrubbed']).toBe('yes');
    c.close();
  });

  it('sends unmodified when beforeSend throws', async () => {
    const f = mockFetch();
    const c = new Client(
      {
        dsn: DSN,
        release: '1.0.0',
        beforeSend: () => {
          throw new Error('beforeSend boom');
        },
      },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    const id = c.captureException(new Error('x'));
    await c.flush();
    expect(id).not.toBe('');
    expect(f.calls).toHaveLength(1);
    c.close();
  });
});

describe('Client - re-entrancy guard', () => {
  it('drops captures triggered from within our own pipeline', async () => {
    const f = mockFetch();
    let beforeSendRuns = 0;
    const c = new Client(
      {
        dsn: DSN,
        release: '1.0.0',
        beforeSend: (e) => {
          beforeSendRuns += 1;
          // Re-enter: this nested capture must be dropped, not looped.
          c.captureException(new Error('reentrant'));
          return e;
        },
      },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('outer'));
    await c.flush();
    expect(beforeSendRuns).toBe(1);
    expect(f.calls).toHaveLength(1);
    c.close();
  });
});

describe('Client - queue policy', () => {
  it('caps the queue at 50, dropping oldest', async () => {
    const f = mockFetch(Array.from({ length: 60 }, () => ({ reject: true })));
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    for (let i = 0; i < 60; i++) c.captureException(new Error(`e${String(i)}`));
    await c.flush();
    expect(c.size()).toBe(50);
    c.close();
  });

  it('drops on a permanent 4xx (400)', async () => {
    const f = mockFetch([{ ok: false, status: 400 }]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('x'));
    await c.flush();
    expect(c.size()).toBe(0);
    c.close();
  });

  it('retains on 5xx and on 429', async () => {
    const f5 = mockFetch([{ ok: false, status: 503 }]);
    const c5 = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f5.fn, proc: fakeProcess().proc },
    );
    c5.captureException(new Error('x'));
    await c5.flush();
    expect(c5.size()).toBe(1);
    c5.close();

    const f429 = mockFetch([{ ok: false, status: 429 }]);
    const c429 = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f429.fn, proc: fakeProcess().proc },
    );
    c429.captureException(new Error('x'));
    await c429.flush();
    expect(c429.size()).toBe(1);
    c429.close();
  });

  it('retains and retries on a network error', async () => {
    const f = mockFetch([{ reject: true }]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('x'));
    await c.flush();
    expect(c.size()).toBe(1);
    c.close();
  });

  it('413 -> trims breadcrumbs to 50 and retries once (success)', async () => {
    const f = mockFetch([
      { ok: false, status: 413 },
      { ok: true, status: 202 },
    ]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0', maxBreadcrumbs: 100 },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    for (let i = 0; i < 60; i++) c.addBreadcrumb({ category: 'log', message: `m${String(i)}` });
    c.captureException(new Error('big'));
    await c.flush();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.env.breadcrumbs).toHaveLength(50);
    expect(c.size()).toBe(0);
    c.close();
  });

  it('413 -> drops on a second 413', async () => {
    const f = mockFetch([
      { ok: false, status: 413 },
      { ok: false, status: 413 },
    ]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException(new Error('big'));
    await c.flush();
    expect(f.calls).toHaveLength(2);
    expect(c.size()).toBe(0);
    c.close();
  });

  it('413 -> retains the TRIMMED (not the oversize) event across a transient failure', async () => {
    // call 1: original 60-breadcrumb event -> 413
    // call 2: trimmed 50-breadcrumb event  -> 500 (retained as the trimmed copy)
    // call 3: trimmed 50-breadcrumb event  -> 202 (delivered)
    const f = mockFetch([
      { ok: false, status: 413 },
      { ok: false, status: 500 },
      { ok: true, status: 202 },
    ]);
    const c = new Client(
      { dsn: DSN, release: '1.0.0', maxBreadcrumbs: 100 },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    for (let i = 0; i < 60; i++) c.addBreadcrumb({ category: 'log', message: `m${String(i)}` });
    c.captureException(new Error('big'));
    await c.flush();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]?.env.breadcrumbs).toHaveLength(60);
    expect(f.calls[1]?.env.breadcrumbs).toHaveLength(50);
    expect(f.calls[2]?.env.breadcrumbs).toHaveLength(50);
    expect(c.size()).toBe(0);
    c.close();
  });
});

describe('Client - safety', () => {
  it('is a no-op with no dsn and never throws from its public surface', async () => {
    const f = mockFetch();
    const c = new Client({ release: '1.0.0' }, { fetchFn: f.fn, proc: fakeProcess().proc });
    expect(c.captureException(new Error('x'))).toBe('');
    expect(c.captureMessage('hi')).toBe('');
    c.addBreadcrumb({ category: 'c', message: 'm' });
    c.setUser({ id: 'u' });
    await c.flush();
    expect(f.calls).toHaveLength(0);
    c.close();
  });

  it('captures non-Error throwables without throwing', async () => {
    const f = mockFetch();
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: f.fn, proc: fakeProcess().proc },
    );
    c.captureException('a string');
    c.captureException(null);
    c.captureException({ weird: 1 });
    await c.flush();
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of f.calls) EventEnvelopeSchema.parse(call.env);
    c.close();
  });

  it('close() removes installed node handlers (double-init teardown)', () => {
    const p = fakeProcess();
    const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: mockFetch().fn, proc: p.proc });
    c.install();
    expect(p.listenerCount('uncaughtException')).toBe(1);
    expect(p.listenerCount('unhandledRejection')).toBe(1);
    c.close();
    expect(p.listenerCount('uncaughtException')).toBe(0);
    expect(p.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('functional API', () => {
  afterEach(() => {
    close();
  });

  it('is safe to call before init and with no dsn', async () => {
    // Nothing initialised yet.
    expect(captureException(new Error('x'))).toBe('');
    expect(captureMessage('x')).toBe('');
    addBreadcrumb({ category: 'c', message: 'm' });
    setUser(null);
    setContext('k', null);
    setTag('k', null);
    setFingerprint(null);
    await flush();

    // No-op init (no dsn) then double init - neither throws.
    init({ release: '1.0.0' });
    init({ release: '1.0.0' });
    expect(captureException(new Error('x'))).toBe('');
  });

  it('init -> capture -> flush end to end (browser override avoids real node handlers)', async () => {
    const f = mockFetch();
    const holder = globalThis as unknown as { fetch?: unknown };
    const realFetch = holder.fetch;
    holder.fetch = f.fn;
    try {
      init({ dsn: DSN, release: '3.1.0+9', runtime: 'browser' });
      const id = captureException(new Error('functional'));
      // second init tears down the first and keeps working
      init({ dsn: DSN, release: '3.1.0+9', runtime: 'browser' });
      const id2 = captureException(new Error('again'));
      await flush();
      expect(id).not.toBe('');
      expect(id2).not.toBe('');
      expect(f.calls.length).toBeGreaterThanOrEqual(1);
      EventEnvelopeSchema.parse(f.calls[0]?.env);
    } finally {
      holder.fetch = realFetch;
    }
  });
});
