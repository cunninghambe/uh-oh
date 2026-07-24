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

export interface RawFetchCall {
  url: string;
  init: FetchInitShape;
}

export interface MockRawFetch {
  fn: (url: string, init: FetchInitShape) => Promise<{ ok: boolean; status: number }>;
  calls: RawFetchCall[];
}

/**
 * A fetch stub for endpoints with no JSON body (e.g. checkIn pings, whose
 * body is the empty string). Behaves like `mockFetch` but records calls
 * verbatim instead of parsing `init.body` as an envelope.
 */
export function mockRawFetch(script: FetchStep[] = []): MockRawFetch {
  const calls: RawFetchCall[] = [];
  const last = script.length > 0 ? script[script.length - 1] : undefined;
  let i = 0;
  const fn = (url: string, init: FetchInitShape): Promise<{ ok: boolean; status: number }> => {
    calls.push({ url, init });
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

export interface FakeLocation {
  loc: { pathname?: string };
  setPath: (p: string) => void;
}

/** A mutable `location`-like fake for auto-analytics tests (defaults to '/'). */
export function fakeLocation(pathname = '/'): FakeLocation {
  const loc: { pathname?: string } = { pathname };
  return {
    loc,
    setPath: (p: string): void => {
      loc.pathname = p;
    },
  };
}

export interface FakeHistory {
  history: {
    pushState: (...args: unknown[]) => unknown;
    replaceState: (...args: unknown[]) => unknown;
  };
  pushCalls: unknown[][];
  replaceCalls: unknown[][];
}

/** A fake `history` for auto-analytics SPA-navigation tests; can be made to throw. */
export function fakeHistory(
  opts: { throwOnPush?: boolean; throwOnReplace?: boolean } = {},
): FakeHistory {
  const pushCalls: unknown[][] = [];
  const replaceCalls: unknown[][] = [];
  return {
    pushCalls,
    replaceCalls,
    history: {
      pushState: (...args: unknown[]): unknown => {
        pushCalls.push(args);
        if (opts.throwOnPush) throw new Error('pushState boom');
        return undefined;
      },
      replaceState: (...args: unknown[]): unknown => {
        replaceCalls.push(args);
        if (opts.throwOnReplace) throw new Error('replaceState boom');
        return undefined;
      },
    },
  };
}

export type FakeConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';

export interface FakeConsoleCall {
  method: FakeConsoleMethod;
  args: unknown[];
  thisArg: unknown;
}

export interface FakeConsole {
  con: Record<FakeConsoleMethod, (...args: unknown[]) => void>;
  calls: FakeConsoleCall[];
}

/**
 * A fake console recording every call (method, args, and `this`) so tests can
 * assert the console-breadcrumbs wrapper always invokes the original with
 * unchanged arguments and `this`. `throwOn` makes one method throw, to
 * exercise the "still call through, then rethrow" path.
 */
export function fakeConsole(opts: { throwOn?: FakeConsoleMethod } = {}): FakeConsole {
  const calls: FakeConsoleCall[] = [];
  const make = (method: FakeConsoleMethod) =>
    function (this: unknown, ...args: unknown[]): void {
      calls.push({ method, args, thisArg: this });
      if (opts.throwOn === method) throw new Error(`${method} boom`);
    };
  return {
    calls,
    con: {
      debug: make('debug'),
      log: make('log'),
      info: make('info'),
      warn: make('warn'),
      error: make('error'),
    },
  };
}

export interface FakeTimers {
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
  /** Fires every currently-pending timer callback (and clears them). */
  fireAll: () => void;
  /** Number of timers currently pending (not yet fired or cleared). */
  pending: () => number;
}

/**
 * A controllable fake for setTimeout/clearTimeout: schedules callbacks
 * without a real delay, letting a test assert nothing fired yet, then fire
 * them deterministically via `fireAll()`. Used for the analytics batching
 * debounce, where a real 5s wait (or firing immediately, which would hide a
 * debounce bug) would not do.
 */
export function fakeTimers(): FakeTimers {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimeoutFn: (cb: () => void): unknown => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    clearTimeoutFn: (handle: unknown): void => {
      pending.delete(handle as number);
    },
    fireAll: (): void => {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb();
    },
    pending: () => pending.size,
  };
}
