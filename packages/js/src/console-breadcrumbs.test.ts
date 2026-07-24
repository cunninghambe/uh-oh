// Tests for opt-in console breadcrumbs: init({ consoleBreadcrumbs: true })
// wraps console.debug/log/info/warn/error, always calling the original
// through, and records a { category: 'console' } breadcrumb per call. See the
// "console breadcrumbs" section of uh-oh-client.ts for the re-entrancy guard
// this suite exercises.

import { describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import { Client } from './uh-oh-client.js';
import { fakeConsole, fakeProcess, mockFetch, type FakeConsole } from './test-support.js';

const DSN = 'https://pk@errors.example.com';

interface Built {
  c: Client;
  f: ReturnType<typeof mockFetch>;
  con: FakeConsole;
}

function build(opts: { consoleBreadcrumbs?: boolean } = {}): Built {
  const f = mockFetch();
  const con = fakeConsole();
  const c = new Client(
    { dsn: DSN, release: '1.0.0', consoleBreadcrumbs: opts.consoleBreadcrumbs ?? true },
    { fetchFn: f.fn, proc: fakeProcess().proc, consoleObj: con.con },
  );
  return { c, f, con };
}

/** Captures an exception and returns its envelope's console-category breadcrumbs. */
async function consoleCrumbs(built: Built) {
  built.c.captureException(new Error('x'));
  await built.c.flush();
  const env = EventEnvelopeSchema.parse(built.f.calls[0]?.env);
  return env.breadcrumbs.filter((b) => b.category === 'console');
}

describe('console breadcrumbs', () => {
  it('hooks debug/log/info/warn/error and maps levels correctly', async () => {
    const built = build();
    built.c.install();
    built.con.con.debug('d');
    built.con.con.log('l');
    built.con.con.info('i');
    built.con.con.warn('w');
    built.con.con.error('e');
    const crumbs = await consoleCrumbs(built);
    expect(crumbs.map((b) => b.level)).toEqual(['debug', 'info', 'info', 'warning', 'error']);
    expect(crumbs.map((b) => b.message)).toEqual(['d', 'l', 'i', 'w', 'e']);
    built.c.close();
  });

  it('always invokes the original with unchanged arguments and this', () => {
    const built = build();
    built.c.install();
    const thisArg = { tag: 'ctx' };
    built.con.con.log.call(thisArg, 'hello', 42, { a: 1 });
    expect(built.con.calls).toHaveLength(1);
    expect(built.con.calls[0]).toMatchObject({
      method: 'log',
      args: ['hello', 42, { a: 1 }],
      thisArg,
    });
    built.c.close();
  });

  it('still calls the original through, and rethrows, when the original throws', () => {
    const f = mockFetch();
    const con = fakeConsole({ throwOn: 'error' });
    const c = new Client(
      { dsn: DSN, release: '1.0.0', consoleBreadcrumbs: true },
      { fetchFn: f.fn, proc: fakeProcess().proc, consoleObj: con.con },
    );
    c.install();
    expect(() => con.con.error('boom')).toThrow('error boom');
    expect(con.calls).toHaveLength(1); // still called through despite the throw
    c.close();
  });

  it('stringifies primitives via String and objects via JSON.stringify, space-joined', async () => {
    const built = build();
    built.c.install();
    built.con.con.log('count:', 3, true, null, undefined, { a: 1, b: [1, 2] });
    const crumbs = await consoleCrumbs(built);
    expect(crumbs[0]?.message).toBe('count: 3 true null undefined {"a":1,"b":[1,2]}');
    built.c.close();
  });

  it('falls back to [unserializable] for a value JSON.stringify cannot handle', async () => {
    const built = build();
    built.c.install();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    built.con.con.error('bad', circular);
    const crumbs = await consoleCrumbs(built);
    expect(crumbs[0]?.message).toBe('bad [unserializable]');
    built.c.close();
  });

  it('caps the recorded message at 500 chars', async () => {
    const built = build();
    built.c.install();
    built.con.con.log('x'.repeat(600));
    const crumbs = await consoleCrumbs(built);
    expect(crumbs[0]?.message).toHaveLength(500);
    built.c.close();
  });

  it('re-entrancy guard: a console call from a toJSON during recording passes through but is not recorded (no recursion)', async () => {
    const built = build();
    built.c.install();
    const obj = {
      toJSON(): unknown {
        built.con.con.log('logged from toJSON');
        return { a: 1 };
      },
    };
    built.con.con.warn('outer', obj);
    const crumbs = await consoleCrumbs(built);
    // Only the outer warn call is recorded - the nested log from toJSON is not.
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]?.level).toBe('warning');
    expect(crumbs[0]?.message).toBe('outer {"a":1}');
    // ...but it still reached the real console, unchanged.
    expect(
      built.con.calls.some(
        (call) => call.method === 'log' && call.args[0] === 'logged from toJSON',
      ),
    ).toBe(true);
    built.c.close();
  });

  it('re-entrancy guard also covers a console call from uh-oh own debug logging', async () => {
    // opts.debug routes this.log('debug', ...) through the same wrapped
    // console object; it must not be recorded as a breadcrumb loop.
    const f = mockFetch();
    const con = fakeConsole();
    const c = new Client(
      { dsn: DSN, release: '1.0.0', consoleBreadcrumbs: true, debug: true },
      { fetchFn: f.fn, proc: fakeProcess().proc, consoleObj: con.con },
    );
    c.install();
    con.con.log('hello');
    c.captureException(new Error('x'));
    await c.flush();
    const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
    const crumbs = env.breadcrumbs.filter((b) => b.category === 'console');
    // Exactly one breadcrumb for the one real console.log call - never a
    // second one for whatever debug logging happened during recording.
    expect(crumbs.filter((b) => b.message === 'hello')).toHaveLength(1);
    c.close();
  });

  it('close() restores the exact original console functions (identity check)', () => {
    const con = fakeConsole();
    const originals = { ...con.con };
    const c = new Client(
      { dsn: DSN, release: '1.0.0', consoleBreadcrumbs: true },
      { fetchFn: mockFetch().fn, proc: fakeProcess().proc, consoleObj: con.con },
    );
    c.install();
    expect(con.con.debug).not.toBe(originals.debug);
    expect(con.con.log).not.toBe(originals.log);
    expect(con.con.info).not.toBe(originals.info);
    expect(con.con.warn).not.toBe(originals.warn);
    expect(con.con.error).not.toBe(originals.error);
    c.close();
    expect(con.con.debug).toBe(originals.debug);
    expect(con.con.log).toBe(originals.log);
    expect(con.con.info).toBe(originals.info);
    expect(con.con.warn).toBe(originals.warn);
    expect(con.con.error).toBe(originals.error);
  });

  it('double-init safe: a second install() on the same instance does not re-wrap or double-record', async () => {
    const built = build();
    built.c.install();
    const afterFirst = built.con.con.log;
    built.c.install();
    expect(built.con.con.log).toBe(afterFirst); // not re-wrapped
    built.con.con.log('once');
    const crumbs = await consoleCrumbs(built);
    expect(crumbs.filter((b) => b.message === 'once')).toHaveLength(1);
    built.c.close();
  });

  it('consoleBreadcrumbs absent leaves the console untouched (identity check)', () => {
    const con = fakeConsole();
    const originals = { ...con.con };
    const c = new Client(
      { dsn: DSN, release: '1.0.0' },
      { fetchFn: mockFetch().fn, proc: fakeProcess().proc, consoleObj: con.con },
    );
    c.install();
    expect(con.con.debug).toBe(originals.debug);
    expect(con.con.log).toBe(originals.log);
    expect(con.con.info).toBe(originals.info);
    expect(con.con.warn).toBe(originals.warn);
    expect(con.con.error).toBe(originals.error);
    c.close();
  });

  it('a captured exception envelope carries the recorded console trail', async () => {
    const built = build();
    built.c.install();
    built.con.con.info('step one');
    built.con.con.warn('careful now');
    built.con.con.error('failing');
    const crumbs = await consoleCrumbs(built);
    expect(crumbs.map((b) => b.message)).toEqual(['step one', 'careful now', 'failing']);
    expect(crumbs.every((b) => b.category === 'console')).toBe(true);
    built.c.close();
  });

  it('never throws even when the injected console lacks some methods', () => {
    const f = mockFetch();
    const partial = { log: (): void => undefined } as unknown as FakeConsole['con'];
    const c = new Client(
      { dsn: DSN, release: '1.0.0', consoleBreadcrumbs: true },
      { fetchFn: f.fn, proc: fakeProcess().proc, consoleObj: partial },
    );
    expect(() => {
      c.install();
      partial.log('x');
      c.close();
    }).not.toThrow();
  });
});
