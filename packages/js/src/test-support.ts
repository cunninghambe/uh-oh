// Shared fakes for the @uh-oh/js tests. Not a *.test.ts (vitest ignores it)
// and not part of the vendored/built output (tsconfig.build.json compiles only
// uh-oh-client.ts). Lets us exercise both the browser and Node runtimes with
// injected stubs, so the suite needs neither jsdom nor a spawned child process.

import type { EventEnvelope } from './uh-oh-client.js';

export interface FetchInitShape {
  method: string;
  headers: Record<string, string>;
  body: string;
  keepalive?: boolean;
  signal?: unknown;
}

export interface FetchCall {
  url: string;
  init: FetchInitShape;
  env: EventEnvelope;
}

export interface FetchStep {
  ok?: boolean;
  status?: number;
  reject?: boolean;
}

export interface MockFetch {
  fn: (url: string, init: FetchInitShape) => Promise<{ ok: boolean; status: number }>;
  calls: FetchCall[];
}

/**
 * A fetch stub whose responses follow `script` in order; once the script is
 * exhausted it REPEATS the last scripted step (so a failure script stays a
 * failure across retries), or 202 OK if the script was empty. Records every
 * call with the parsed envelope.
 */
export function mockFetch(script: FetchStep[] = []): MockFetch {
  const calls: FetchCall[] = [];
  const last = script.length > 0 ? script[script.length - 1] : undefined;
  let i = 0;
  const fn = (url: string, init: FetchInitShape): Promise<{ ok: boolean; status: number }> => {
    const env = JSON.parse(init.body) as EventEnvelope;
    calls.push({ url, init, env });
    const step = script[i] ?? last ?? {};
    i += 1;
    if (step.reject) return Promise.reject(new Error('network down'));
    return Promise.resolve({ ok: step.ok ?? true, status: step.status ?? 202 });
  };
  return { fn, calls };
}

export interface FakeStorage {
  storage: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
    removeItem: (k: string) => void;
  };
  map: Map<string, string>;
  failGet: () => void;
  failSet: () => void;
}

export function fakeStorage(initial?: Record<string, string>): FakeStorage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  let mode: 'ok' | 'get' | 'set' = 'ok';
  return {
    map,
    failGet: () => {
      mode = 'get';
    },
    failSet: () => {
      mode = 'set';
    },
    storage: {
      getItem: (k: string): string | null => {
        if (mode === 'get') throw new Error('storage read blocked');
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string): void => {
        if (mode === 'set') throw new Error('storage quota exceeded');
        map.set(k, v);
      },
      removeItem: (k: string): void => {
        map.delete(k);
      },
    },
  };
}

export interface FakeProcess {
  proc: {
    platform: string;
    version: string;
    arch: string;
    on: (event: string, listener: (arg: unknown) => void) => void;
    off: (event: string, listener: (arg: unknown) => void) => void;
    listeners: (event: string) => unknown[];
    exit: (code?: number) => void;
    stderr: { write: (s: string) => void };
  };
  trigger: (event: string, arg: unknown) => Promise<void>;
  exitCalls: number[];
  stderrWrites: string[];
  listenerCount: (event: string) => number;
}

export function fakeProcess(
  opts: { existingUncaught?: number; platform?: string; version?: string; arch?: string } = {},
): FakeProcess {
  const handlers = new Map<string, Array<(arg: unknown) => void>>();
  if (opts.existingUncaught && opts.existingUncaught > 0) {
    handlers.set(
      'uncaughtException',
      Array.from({ length: opts.existingUncaught }, () => () => undefined),
    );
  }
  const exitCalls: number[] = [];
  const stderrWrites: string[] = [];
  const proc = {
    platform: opts.platform ?? 'linux',
    version: opts.version ?? 'v20.0.0',
    arch: opts.arch ?? 'x64',
    on: (event: string, listener: (arg: unknown) => void): void => {
      const arr = handlers.get(event) ?? [];
      arr.push(listener);
      handlers.set(event, arr);
    },
    off: (event: string, listener: (arg: unknown) => void): void => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== listener),
      );
    },
    listeners: (event: string): unknown[] => [...(handlers.get(event) ?? [])],
    exit: (code?: number): void => {
      exitCalls.push(code ?? 0);
    },
    stderr: {
      write: (s: string): void => {
        stderrWrites.push(s);
      },
    },
  };
  const trigger = async (event: string, arg: unknown): Promise<void> => {
    for (const h of [...(handlers.get(event) ?? [])]) {
      const r: unknown = h(arg);
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        await (r as Promise<void>);
      }
    }
  };
  return {
    proc,
    trigger,
    exitCalls,
    stderrWrites,
    listenerCount: (e: string): number => (handlers.get(e) ?? []).length,
  };
}

export interface FakeWindow {
  win: {
    addEventListener: (type: string, listener: (ev: unknown) => void) => void;
    removeEventListener: (type: string, listener: (ev: unknown) => void) => void;
  };
  dispatch: (type: string, ev: unknown) => void;
  count: (type: string) => number;
}

export function fakeWindow(): FakeWindow {
  const handlers = new Map<string, Array<(ev: unknown) => void>>();
  return {
    win: {
      addEventListener: (type: string, listener: (ev: unknown) => void): void => {
        const arr = handlers.get(type) ?? [];
        arr.push(listener);
        handlers.set(type, arr);
      },
      removeEventListener: (type: string, listener: (ev: unknown) => void): void => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((h) => h !== listener),
        );
      },
    },
    dispatch: (type: string, ev: unknown): void => {
      for (const h of [...(handlers.get(type) ?? [])]) h(ev);
    },
    count: (type: string): number => (handlers.get(type) ?? []).length,
  };
}

export interface FakeNavigator {
  nav: {
    userAgent: string;
    language: string;
    sendBeacon: (url: string, data?: unknown) => boolean;
  };
  beaconCalls: Array<{ url: string; data: unknown }>;
}

export function fakeNavigator(
  opts: { userAgent?: string; language?: string; beaconOk?: boolean } = {},
): FakeNavigator {
  const beaconCalls: Array<{ url: string; data: unknown }> = [];
  return {
    beaconCalls,
    nav: {
      userAgent: opts.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      language: opts.language ?? 'en-US',
      sendBeacon: (url: string, data?: unknown): boolean => {
        beaconCalls.push({ url, data });
        return opts.beaconOk ?? true;
      },
    },
  };
}
