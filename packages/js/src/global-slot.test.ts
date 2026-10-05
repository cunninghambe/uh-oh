// The functional API shares one client through a Symbol.for slot on
// globalThis, so a SECOND evaluation of this file in the same process sees the
// client the first one initialised. That second evaluation is what a bundler
// produces when the client lands in two module graphs: in kanbanmcp's Next.js
// 16 (Turbopack) build, instrumentation.ts and the API routes load the client
// as different modules, and the route copy's captureException was compiled to
// a stub returning "" because init() never ran in that graph.
//
// Vite evaluates `./uh-oh-client.ts?copy=x` as its own module instance, which
// stands in for that second module graph here.

import { afterEach, describe, expect, it } from 'vitest';
import { EventEnvelopeSchema } from '@uh-oh/types';

import * as copyA from './uh-oh-client.js';
import { mockFetch } from './test-support.js';

type ClientModule = typeof copyA;

const SLOT = Symbol.for('uh-oh.client');
const DSN = 'https://pk@errors.example.com';
const slotHost = globalThis as unknown as Record<symbol, unknown>;

async function secondCopy(tag: string): Promise<ClientModule> {
  return (await import(/* @vite-ignore */ `./uh-oh-client.ts?copy=${tag}`)) as ClientModule;
}

/** Points the global fetch the client resolves at a mock for one test. */
function withFetch(): ReturnType<typeof mockFetch> & { restore: () => void } {
  const f = mockFetch();
  const holder = globalThis as unknown as { fetch?: unknown };
  const real = holder.fetch;
  holder.fetch = f.fn;
  return {
    ...f,
    restore: () => {
      holder.fetch = real;
    },
  };
}

afterEach(() => {
  copyA.close();
  delete slotHost[SLOT];
});

describe('process-global client slot', () => {
  it('the second copy really is a separate module instance (guards the test)', async () => {
    const copyB = await secondCopy('guard');
    expect(copyB.Client).not.toBe(copyA.Client);
    expect(copyB.init).not.toBe(copyA.init);
  });

  it('captureException from a copy that never ran init() reaches the initialised client', async () => {
    const f = withFetch();
    try {
      const route = await secondCopy('route');
      // `runtime: 'browser'` with no window installs no real process handlers.
      copyA.init({ dsn: DSN, release: '2.0.0+5', runtime: 'browser' });

      const id = route.captureException(new Error('thrown in a route handler'));
      expect(id).not.toBe('');
      await route.flush();

      expect(f.calls).toHaveLength(1);
      const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
      expect(env.exception.value).toBe('thrown in a route handler');
      expect(env.release).toEqual({ version: '2.0.0', build: '5' });
    } finally {
      f.restore();
    }
  });

  it('scope set from one copy applies to events captured from another', async () => {
    const f = withFetch();
    try {
      const route = await secondCopy('scope');
      copyA.init({ dsn: DSN, release: '1.0.0', runtime: 'browser' });
      route.setTag('route', '/api/mcp');
      route.addBreadcrumb({ category: 'db', message: 'query' });
      copyA.captureException(new Error('x'));
      await copyA.flush();
      const env = EventEnvelopeSchema.parse(f.calls[0]?.env);
      expect(env.tags).toEqual({ route: '/api/mcp' });
      expect(env.breadcrumbs.map((b) => b.message)).toEqual(['query']);
    } finally {
      f.restore();
    }
  });

  it('init() from a second copy closes the first client instead of running two', async () => {
    const copyB = await secondCopy('reinit');
    copyA.init({ dsn: DSN, release: '1.0.0', runtime: 'browser' });
    const first = slotHost[SLOT] as copyA.Client;
    expect(first).toBeInstanceOf(copyA.Client);

    copyB.init({ dsn: DSN, release: '1.0.1', runtime: 'browser' });
    const second = slotHost[SLOT];
    expect(second).toBeInstanceOf(copyB.Client);
    expect(second).not.toBe(first);
    // The replaced client is closed: it no longer captures.
    expect(first.captureException(new Error('late'))).toBe('');
  });

  it('close() from any copy clears the slot for every copy', async () => {
    const copyB = await secondCopy('close');
    copyA.init({ dsn: DSN, release: '1.0.0', runtime: 'browser' });
    copyB.close();
    expect(slotHost[SLOT]).toBeNull();
    expect(copyA.captureException(new Error('after close'))).toBe('');
    expect(copyB.captureException(new Error('after close'))).toBe('');
  });

  it('a foreign value in the slot is ignored, never called', () => {
    slotHost[SLOT] = { captureException: 'not a function' };
    expect(copyA.captureException(new Error('x'))).toBe('');
    expect(() => copyA.flush()).not.toThrow();
  });

  it('falls back to a per-copy client when the global slot cannot be written', async () => {
    Object.defineProperty(globalThis, SLOT, {
      configurable: true,
      get: () => undefined,
      set: () => {
        throw new TypeError('locked down');
      },
    });
    const f = withFetch();
    try {
      const copyB = await secondCopy('locked');
      expect(() => copyA.init({ dsn: DSN, release: '1.0.0', runtime: 'browser' })).not.toThrow();
      expect(copyA.captureException(new Error('own client'))).not.toBe('');
      // No shared slot, so the uninitialised copy stays a silent no-op.
      expect(copyB.captureException(new Error('unshared'))).toBe('');
      await copyA.flush();
      expect(f.calls.map((c) => c.env.exception.value)).toEqual(['own client']);
    } finally {
      f.restore();
    }
  });
});
