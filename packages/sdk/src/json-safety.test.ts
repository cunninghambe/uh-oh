// A value JSON cannot serialize (a BigInt, a cycle, a throwing toJSON) in
// breadcrumb data, context or user must not cost the crash report. Before,
// Spool._fitEntry's JSON.stringify threw, enqueue rejected, and the event was
// silently dropped; a BigInt in one breadcrumb dropped EVERY crash captured
// while that breadcrumb was still in the 100-slot buffer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEnvelopeSchema, type EventEnvelope } from '@uh-oh/types';

import { Client } from './client.js';
import { Spool, type AsyncStorageLike } from './spool.js';
import { setUhOhNativeStub } from './__test-stubs__/react-native.js';

function makeStorage(): AsyncStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: (k) => Promise.resolve(store.get(k) ?? null),
    setItem: (k, v) => {
      store.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
}

const DSN = 'https://testkey@errors.example.com';
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

/** Reads what the client spooled. start() is never called, so nothing drains. */
async function spooled(storage: AsyncStorageLike): Promise<EventEnvelope[]> {
  const sent: EventEnvelope[] = [];
  await new Spool(storage).drain((env) => {
    sent.push(env);
    return Promise.resolve({ ok: true, status: 202 });
  });
  return sent;
}

// The server validates every envelope against EventEnvelopeSchema and answers
// 400 when a field is over its cap; the spool treats 4xx as permanent and
// drops the event. So the SDK must never build an envelope the schema
// rejects: a long error message, a deep stack (a stack overflow), or a long
// breadcrumb used to cost the whole crash report.
describe('envelopes always fit the wire schema', () => {
  it('a long message, long type and deep stack are truncated, not rejected', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '1.0.0+1', enableNative: false }, storage);
    const err = new Error('m'.repeat(5000));
    err.name = 'T'.repeat(300);
    err.stack = [
      `${err.name}: ${err.message}`,
      ...Array.from(
        { length: 700 },
        (_, i) => `    at f${String(i)} (${'p'.repeat(1100)}.js:1:${String(i)})`,
      ),
    ].join('\n');
    client.captureException(err);
    await settle();

    const envs = await spooled(storage);
    expect(envs).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(envs[0]);
    expect(env.exception.value).toHaveLength(4096);
    expect(env.exception.type).toHaveLength(256);
    expect(env.exception.stacktrace).toHaveLength(500);
    expect(env.exception.stacktrace[0]?.filename).toHaveLength(1024);
  });

  it('long or empty breadcrumb fields are clamped to the schema', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '1.0.0+1', enableNative: false }, storage);
    client.addBreadcrumb({ category: 'c'.repeat(100), message: 'x'.repeat(2000) });
    client.addBreadcrumb({ category: '', message: 'empty category' });
    client.captureException(new Error('crumbs'));
    await settle();

    const envs = await spooled(storage);
    const env = EventEnvelopeSchema.parse(envs[0]);
    expect(env.breadcrumbs[0]?.category).toHaveLength(64);
    expect(env.breadcrumbs[0]?.message).toHaveLength(1024);
    expect(env.breadcrumbs[1]?.category).toBe('default');
  });

  it('an empty release still produces a valid release', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '', enableNative: false }, storage);
    client.captureException(new Error('no release'));
    await settle();
    const env = EventEnvelopeSchema.parse((await spooled(storage))[0]);
    expect(env.release).toEqual({ version: '0.0.0', build: '0' });
  });

  it('maxBreadcrumbs above the wire cap still sends at most 100 breadcrumbs', async () => {
    const storage = makeStorage();
    const client = new Client(
      { dsn: DSN, release: '1.0.0+1', enableNative: false, maxBreadcrumbs: 200 },
      storage,
    );
    for (let i = 0; i < 150; i++) client.addBreadcrumb({ category: 'nav', message: String(i) });
    client.captureException(new Error('many crumbs'));
    await settle();
    const env = EventEnvelopeSchema.parse((await spooled(storage))[0]);
    expect(env.breadcrumbs).toHaveLength(100);
    expect(env.breadcrumbs[99]?.message).toBe('149');
  });
});

// Native reports come from CrashWriter.java and reach JS through the bridge
// as plain data. Before, `_buildEnvelopeFromPartial` passed their exception
// through unchanged, so the server 400'd (and the spool dropped) a Java crash
// whose report broke the schema.
describe('native crash reports always fit the wire schema', () => {
  let origFetch: typeof fetch;
  let bodies: unknown[];

  beforeEach(() => {
    bodies = [];
    origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, status: 202 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    setUhOhNativeStub({
      install: () => Promise.resolve(true),
      getPendingReports: () => Promise.resolve([]),
    });
  });

  /** Starts a client that collects `payload` as a pending native report and returns what it sent. */
  async function sendNative(payload: Record<string, unknown>): Promise<unknown[]> {
    const ack = vi.fn(() => Promise.resolve());
    setUhOhNativeStub({
      install: () => Promise.resolve(true),
      getPendingReports: () => Promise.resolve([{ id: 'r1', payload }]),
      ackReport: ack,
    });
    const client = new Client({ dsn: DSN, release: '1.0.0+1' }, makeStorage(), {
      loadNetInfo: () => null,
      loadRejectionTracking: () => null,
    });
    client.start();
    await settle();
    client.stop();
    expect(ack).toHaveBeenCalledWith('r1');
    return bodies;
  }

  // The exact shape CrashWriter.buildJavaReport writes (CrashWriter.java
  // 97-132): `mechanism` sits on the report, not on the exception, and
  // StackTraceElement.getLineNumber() is -2 for a native method, which ends
  // practically every main-thread Android trace (Method.invoke).
  it('a Java uncaught exception report as CrashWriter writes it', async () => {
    const sent = await sendNative({
      mechanism: 'android-java-ueh',
      timestamp: '2026-10-03T12:00:00.000Z',
      exception: {
        type: 'java.lang.IllegalStateException',
        value: 'boom',
        stacktrace: [
          {
            module: 'com.example.Main',
            function: 'onClick',
            filename: 'Main.java',
            lineno: 42,
            inApp: true,
          },
          {
            module: 'java.lang.reflect.Method',
            function: 'invoke',
            filename: '',
            lineno: -2,
            inApp: false,
          },
          {
            module: 'com.android.internal.os.RuntimeInit$MethodAndArgsCaller',
            function: 'run',
            filename: 'RuntimeInit.java',
            lineno: 548,
            inApp: false,
          },
        ],
      },
      device: { osName: 'Android', osVersion: '14', deviceModel: 'Pixel 8', sdkInt: 34 },
      thread: { name: 'main', id: 2 },
    });
    expect(sent).toHaveLength(1);
    const env = EventEnvelopeSchema.parse(sent[0]);
    expect(env.exception.mechanism).toBe('android-java-ueh');
    expect(env.exception.stacktrace[0]).toMatchObject({ function: 'onClick', lineno: 42 });
    expect(env.exception.stacktrace[1]).toEqual({
      module: 'java.lang.reflect.Method',
      function: 'invoke',
      filename: '',
      inApp: false,
    });
  });

  it('a StackOverflowError with a long message and long native symbols is clamped', async () => {
    const sent = await sendNative({
      mechanism: 'android-ndk-signal',
      timestamp: '2026-10-03T12:00:00.000Z',
      exception: {
        type: 'S'.repeat(300),
        value: 'v'.repeat(5000),
        mechanism: 'android-ndk-signal',
        // A deep recursion; the first frames carry over-long C++ symbols
        // (kept to a few so the report stays under the spool's 1 MB cap).
        stacktrace: Array.from({ length: 1024 }, (_, i) => ({
          instructionAddr: i === 0 ? 'not-hex' : `0x${i.toString(16)}`,
          module: i < 3 ? 'm'.repeat(600) : 'libapp.so',
          function: i < 3 ? 'f'.repeat(700) : 'recurse',
          filename: i < 3 ? 'p'.repeat(1100) : 'app.cpp',
          lineno: i,
          inApp: true,
        })),
      },
      device: { osName: 'Android', osVersion: '14' },
    });
    const env = EventEnvelopeSchema.parse(sent[0]);
    expect(env.exception.type).toHaveLength(256);
    expect(env.exception.value).toHaveLength(4096);
    expect(env.exception.stacktrace).toHaveLength(500);
    const [first, second] = env.exception.stacktrace;
    expect(first?.instructionAddr).toBeUndefined();
    expect(second?.instructionAddr).toBe('0x1');
    expect(second?.module).toHaveLength(512);
    expect(second?.function).toHaveLength(512);
    expect(second?.filename).toHaveLength(1024);
  });

  it('a BigInt in scope context does not cost a native report', async () => {
    const ack = vi.fn(() => Promise.resolve());
    setUhOhNativeStub({
      install: () => Promise.resolve(true),
      getPendingReports: () =>
        Promise.resolve([
          {
            id: 'r2',
            payload: {
              mechanism: 'android-anr',
              exception: { type: 'ANR', value: '', mechanism: 'android-anr', stacktrace: [] },
              device: { osName: 'Android', osVersion: '14' },
            },
          },
        ]),
      ackReport: ack,
    });
    const client = new Client({ dsn: DSN, release: '1.0.0+1' }, makeStorage(), {
      loadNetInfo: () => null,
      loadRejectionTracking: () => null,
    });
    client.scope.setContext('db', { rowId: BigInt(9) });
    client.start();
    await settle();
    client.stop();
    expect(ack).toHaveBeenCalledWith('r2');
    expect(EventEnvelopeSchema.parse(bodies[0]).context?.['db']).toEqual({ rowId: '9' });
  });
});

describe('values JSON cannot serialize never cost a crash report', () => {
  it('a BigInt breadcrumb is stringified and every later crash is still spooled', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '1.0.0+1', enableNative: false }, storage);
    client.addBreadcrumb({ category: 'db', message: 'row', data: { id: BigInt(7) } });
    client.captureException(new Error('one'));
    client.captureException(new Error('two'));
    await settle();

    const envs = await spooled(storage);
    expect(envs.map((e) => e.exception.value)).toEqual(['one', 'two']);
    const env = EventEnvelopeSchema.parse(envs[0]);
    expect(env.breadcrumbs[0]?.data).toEqual({ id: '7' });
  });

  it('a cycle in context becomes "[Circular]"', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '1.0.0+1', enableNative: false }, storage);
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    client.scope.setContext('graph', node);
    client.captureException(new Error('cyclic'));
    await settle();

    const envs = await spooled(storage);
    expect(envs).toHaveLength(1);
    expect(EventEnvelopeSchema.parse(envs[0]).context?.['graph']).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });

  it('a throwing toJSON is replaced, not fatal', async () => {
    const storage = makeStorage();
    const client = new Client({ dsn: DSN, release: '1.0.0+1', enableNative: false }, storage);
    client.scope.setContext('k', {
      bad: {
        toJSON(): never {
          throw new Error('nope');
        },
      },
    });
    client.captureMessage('hello');
    await settle();
    const envs = await spooled(storage);
    expect(envs).toHaveLength(1);
    expect(EventEnvelopeSchema.parse(envs[0]).context?.['k']).toEqual({ bad: '[unserializable]' });
  });
});
