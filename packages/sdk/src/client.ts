import type { EventEnvelope, Level, BreadcrumbLevel, JsonValue, StackFrame } from '@uh-oh/types';
import { Scope } from './scope.js';
import { BreadcrumbBuffer } from './breadcrumbs.js';
import { Spool, type AsyncStorageLike } from './spool.js';
import { sendEvent } from './transport.js';
import { parseDsn, type Dsn } from './dsn.js';
import { platform, osVersion } from './platform.js';
import {
  installGlobalErrorHandler,
  installPromiseRejectionHandler,
  type RejectionHandlerDeps,
} from './handlers.js';
import { nativeBridge } from './native-bridge.js';

export type InitOptions = {
  dsn: string;
  release: string;
  environment?: string;
  beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
  maxBreadcrumbs?: number;
  debug?: boolean;
  enableNative?: boolean;
};

type BreadcrumbInput = {
  category: string;
  message: string;
  level?: BreadcrumbLevel;
  data?: Record<string, unknown>;
};

/** Minimal NetInfo surface we depend on (optional peer dependency). */
type NetInfoLike = {
  addEventListener(cb: (state: { isConnected: boolean | null }) => void): () => void;
};

/** Injectable dependencies (for tests); production uses guarded requires. */
export type ClientDeps = {
  loadNetInfo?: () => NetInfoLike | null;
  loadRejectionTracking?: RejectionHandlerDeps['loadRejectionTracking'];
};

const FLUSH_INTERVAL_MS = 30_000;

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Minimal fallback for environments without crypto.randomUUID
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function parseRelease(release: string): { version: string; build: string } {
  const parts = release.split('+');
  return {
    version: parts[0] ?? release,
    build: parts[1] ?? '0',
  };
}

/**
 * Parses a single stack line into a StackFrame. Supports:
 *  - V8:        `at fn (file:line:col)`
 *  - anonymous: `at file:line:col`
 *  - Hermes:    `at fn (address at bundle:line:col)`
 * Lines that don't match yield a location-less in-app frame (preserving the
 * previous behaviour of one frame per line).
 */
function parseStackLine(line: string): StackFrame {
  // Function + parenthesised location (V8 and Hermes "address at ..." forms).
  const withFn = /^\s*at\s+.+?\s+\((?:address at\s+)?(.+):(\d+):(\d+)\)\s*$/.exec(line);
  if (withFn) {
    return {
      inApp: true,
      filename: withFn[1] ?? '',
      lineno: parseInt(withFn[2] ?? '0', 10),
      colno: parseInt(withFn[3] ?? '0', 10),
    };
  }

  // Anonymous frame with a bare location (optionally Hermes "address at ...").
  const anon = /^\s*at\s+(?:address at\s+)?(.+):(\d+):(\d+)\s*$/.exec(line);
  if (anon) {
    return {
      inApp: true,
      filename: anon[1] ?? '',
      lineno: parseInt(anon[2] ?? '0', 10),
      colno: parseInt(anon[3] ?? '0', 10),
    };
  }

  return { inApp: true };
}

function errorToException(
  err: unknown,
  mechanism: 'js-global' | 'js-promise' | 'js-manual',
): EventEnvelope['exception'] {
  if (err instanceof Error) {
    const frames = (err.stack ?? '').split('\n').slice(1).map(parseStackLine);
    return {
      type: err.name || 'Error',
      value: err.message,
      stacktrace: frames,
      mechanism,
    };
  }
  return {
    type: 'UnknownError',
    value: String(err),
    stacktrace: [],
    mechanism,
  };
}

function defaultLoadNetInfo(): NetInfoLike | null {
  try {
    // Optional peer dependency; absent in most apps and in tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-community/netinfo') as
      | NetInfoLike
      | { default?: NetInfoLike };
    const ni = (mod as { default?: NetInfoLike }).default ?? (mod as NetInfoLike);
    return typeof ni?.addEventListener === 'function' ? ni : null;
  } catch {
    return null;
  }
}

/**
 * Lazily resolves AsyncStorage on first use. If the peer dependency is absent
 * (e.g. iOS, or an app that never installed it) it falls back to an in-memory
 * queue with the same interface — so `init` never throws (C4, SPEC §12 #22).
 */
export function createLazyAsyncStorage(
  debug: boolean,
  load: () => AsyncStorageLike = () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage') as {
      default: AsyncStorageLike;
    };
    return mod.default;
  },
): AsyncStorageLike {
  let resolved: AsyncStorageLike | null = null;
  let didResolve = false;
  const memory = new Map<string, string>();
  const memoryStore: AsyncStorageLike = {
    getItem: (k) => Promise.resolve(memory.get(k) ?? null),
    setItem: (k, v) => {
      memory.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      memory.delete(k);
      return Promise.resolve();
    },
  };

  const resolve = (): AsyncStorageLike => {
    if (didResolve) return resolved ?? memoryStore;
    didResolve = true;
    try {
      resolved = load();
    } catch {
      if (debug) {
        console.debug('uh-oh: AsyncStorage unavailable; using in-memory spool (no persistence)');
      }
      resolved = null;
    }
    return resolved ?? memoryStore;
  };

  return {
    getItem: (k) => resolve().getItem(k),
    setItem: (k, v) => resolve().setItem(k, v),
    removeItem: (k) => resolve().removeItem(k),
  };
}

export class Client {
  readonly scope: Scope;
  private readonly breadcrumbs: BreadcrumbBuffer;
  private readonly spool: Spool;
  private readonly opts: InitOptions;
  private dsn: Dsn | null = null;
  private readonly noop: boolean;
  private uninstallHandlers: Array<() => void> = [];
  private readonly loadNetInfo: () => NetInfoLike | null;
  private readonly loadRejectionTracking: RejectionHandlerDeps['loadRejectionTracking'];
  private netInfoUnsub: (() => void) | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard: drops captures triggered by our own capture path (C1). */
  private capturing = false;

  constructor(opts: InitOptions, storage?: AsyncStorageLike, deps: ClientDeps = {}) {
    this.opts = opts;
    this.noop = platform() === 'ios';
    this.scope = new Scope();
    this.breadcrumbs = new BreadcrumbBuffer(opts.maxBreadcrumbs ?? 100);
    this.loadNetInfo = deps.loadNetInfo ?? defaultLoadNetInfo;
    this.loadRejectionTracking = deps.loadRejectionTracking;

    // Allow injecting storage for tests; otherwise resolve AsyncStorage lazily
    // so a missing peer dependency can't throw from the constructor.
    const asyncStorage = storage ?? createLazyAsyncStorage(opts.debug ?? false);
    this.spool = new Spool(asyncStorage, opts.debug ?? false);
  }

  start(): void {
    if (this.noop) {
      if (this.opts.debug) console.debug('uh-oh: iOS unsupported, no-op');
      return;
    }

    try {
      this.dsn = parseDsn(this.opts.dsn);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      return;
    }

    const capture = (err: unknown, mechanism: 'js-global' | 'js-promise') =>
      this._capture(err, mechanism);

    // Handler installation must never throw (C3).
    try {
      const rejectionDeps: RejectionHandlerDeps = {};
      if (this.loadRejectionTracking) {
        rejectionDeps.loadRejectionTracking = this.loadRejectionTracking;
      }
      this.uninstallHandlers.push(
        installGlobalErrorHandler((err) => capture(err, 'js-global')),
        installPromiseRejectionHandler((reason) => capture(reason, 'js-promise'), rejectionDeps),
      );
    } catch (e) {
      if (this.opts.debug) console.debug('uh-oh: failed to install error handlers', e);
    }

    // Connectivity-triggered flush: prefer NetInfo, else a spool-gated timer (M5).
    this._installConnectivityFlush();

    if (this.opts.enableNative !== false) {
      void this._installNativeAndDrainPending().catch((e) => {
        if (this.opts.debug) console.debug('uh-oh: native install/drain failed', e);
      });
    } else {
      void this._drain().catch((e) => {
        if (this.opts.debug) console.debug('uh-oh: initial drain failed', e);
      });
    }
  }

  private _installConnectivityFlush(): void {
    const netInfo = this.loadNetInfo();
    if (netInfo && typeof netInfo.addEventListener === 'function') {
      try {
        this.netInfoUnsub = netInfo.addEventListener((state) => {
          if (state && state.isConnected) {
            void this._drain().catch((e) => {
              if (this.opts.debug) console.debug('uh-oh: reconnect drain failed', e);
            });
          }
        });
      } catch (e) {
        if (this.opts.debug) console.debug('uh-oh: NetInfo subscription failed', e);
        this.netInfoUnsub = null;
      }
    }
  }

  private async _installNativeAndDrainPending(): Promise<void> {
    const bridge = nativeBridge();
    if (bridge) {
      try {
        await bridge.install({ debug: this.opts.debug ?? false });
        const reports = await bridge.getPendingReports();
        for (const r of reports) {
          const fullEnv = this._buildEnvelopeFromPartial(r.payload);
          try {
            await this.spool.enqueue(fullEnv);
            // Durable handoff complete — only now is it safe to delete the file.
            if (r.id) await bridge.ackReport(r.id);
          } catch (e) {
            // Spool write failed: do NOT ack, so the report survives to the
            // next launch instead of being lost (M1).
            if (this.opts.debug) {
              console.debug('uh-oh: failed to spool native report; retaining on disk', e);
            }
          }
        }
      } catch (e) {
        if (this.opts.debug) console.debug('uh-oh: native bridge install/collect failed', e);
      }
    }
    await this._drain();
  }

  stop(): void {
    for (const fn of this.uninstallHandlers) {
      try {
        fn();
      } catch {
        // best-effort teardown
      }
    }
    this.uninstallHandlers = [];
    if (this.netInfoUnsub) {
      try {
        this.netInfoUnsub();
      } catch {
        // best-effort teardown
      }
      this.netInfoUnsub = null;
    }
    this._clearFlushTimer();
  }

  captureException(
    err: unknown,
    ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): string {
    if (this.noop) return '';
    return this._capture(err, 'js-manual', ctx);
  }

  captureMessage(msg: string, level: Level = 'info'): string {
    if (this.noop) return '';
    const fakeErr = new Error(msg);
    fakeErr.name = 'Message';
    const id = uuid();
    const env = this._buildEnvelope(fakeErr, 'js-manual', level, undefined, id);
    if (!env) return '';
    this._spoolAndDrain(env);
    return id;
  }

  addBreadcrumb(b: BreadcrumbInput): void {
    if (this.noop) return;
    this.breadcrumbs.add(b);
  }

  private _capture(
    err: unknown,
    mechanism: 'js-global' | 'js-promise' | 'js-manual',
    ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): string {
    // Re-entrancy guard: if an error is thrown *by* our own capture path while
    // we're mid-capture, drop it rather than feed an unbounded loop (C1).
    if (this.capturing) {
      if (this.opts.debug) console.debug('uh-oh: dropped re-entrant capture');
      return '';
    }
    this.capturing = true;
    try {
      const id = uuid();
      const env = this._buildEnvelope(err, mechanism, 'error', ctx, id);
      if (!env) return '';
      this._spoolAndDrain(env);
      return id;
    } finally {
      this.capturing = false;
    }
  }

  /**
   * Enqueues an envelope and kicks a drain, swallowing any failure with a
   * debug log. Never produces an unhandled rejection — which would otherwise be
   * re-captured by our own promise-rejection handler, looping (C1).
   */
  private _spoolAndDrain(env: EventEnvelope): void {
    void this.spool
      .enqueue(env)
      .then(() => void this._drain())
      .catch((e) => {
        if (this.opts.debug) console.debug('uh-oh: enqueue/drain failed', e);
      });
  }

  private _buildEnvelope(
    err: unknown,
    mechanism: 'js-global' | 'js-promise' | 'js-manual',
    level: Level = 'error',
    ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
    eventId?: string,
  ): EventEnvelope | null {
    const snap = this.scope.snapshot();
    const { version, build } = parseRelease(this.opts.release);

    const mergedTags = {
      ...(snap.tags ?? {}),
      ...(ctx?.tags ?? {}),
    };

    // `environment` and the returned event id are not top-level wire fields
    // (see @uh-oh/types), so they ride along in `context` (L1, L4).
    const mergedContext: Record<string, JsonValue> = {
      ...(snap.context ?? {}),
      ...(this.opts.environment !== undefined ? { environment: this.opts.environment } : {}),
      ...(eventId !== undefined ? { eventId } : {}),
      ...(ctx?.extra ? { extra: ctx.extra as Record<string, JsonValue> } : {}),
    };

    const env: EventEnvelope = {
      sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
      timestamp: new Date().toISOString(),
      platform: 'android',
      release: { version, build },
      level,
      exception: errorToException(err, mechanism),
      breadcrumbs: this.breadcrumbs.get(),
      device: { osName: 'Android', osVersion: osVersion() },
      ...(snap.user !== undefined ? { user: snap.user } : {}),
      ...(Object.keys(mergedTags).length > 0 ? { tags: mergedTags } : {}),
      ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
      ...(snap.fingerprint !== undefined ? { fingerprint: snap.fingerprint } : {}),
    };

    if (this.opts.beforeSend) {
      try {
        const result = this.opts.beforeSend(env);
        if (result === null) return null;
        return result;
      } catch (e) {
        // A throwing beforeSend must not drop the crash: send it unmodified (H3).
        if (this.opts.debug) console.debug('uh-oh: beforeSend threw; sending unmodified event', e);
        return env;
      }
    }

    return env;
  }

  /**
   * Builds a full EventEnvelope from a partial report written by the native
   * crash handler. The native side provides exception, timestamp, and device;
   * this method fills in sdk, release, platform, level, breadcrumbs, and scope.
   */
  private _buildEnvelopeFromPartial(partial: Partial<EventEnvelope>): EventEnvelope {
    const snap = this.scope.snapshot();
    const { version, build } = parseRelease(this.opts.release);
    const mergedTags = { ...(snap.tags ?? {}), ...(partial.tags ?? {}) };
    const mergedContext = { ...(snap.context ?? {}), ...(partial.context ?? {}) };

    const env: EventEnvelope = {
      sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
      timestamp: partial.timestamp ?? new Date().toISOString(),
      platform: 'android',
      release: { version, build },
      level: partial.level ?? 'fatal',
      exception: partial.exception ?? {
        type: 'UnknownNativeCrash',
        value: '',
        stacktrace: [],
        mechanism: 'android-java-ueh',
      },
      breadcrumbs: [],
      device: partial.device ?? { osName: 'Android', osVersion: 'unknown' },
      ...(snap.user !== undefined ? { user: snap.user } : {}),
      ...(Object.keys(mergedTags).length > 0 ? { tags: mergedTags } : {}),
      ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
      ...(snap.fingerprint !== undefined ? { fingerprint: snap.fingerprint } : {}),
    };

    return env;
  }

  private async _drain(): Promise<void> {
    if (!this.dsn) return;
    const { baseUrl, publicKey } = this.dsn;
    await this.spool.drain((env) => sendEvent(baseUrl, publicKey, env));

    // Manage the retry timer based on whether anything is still pending (M5).
    try {
      if ((await this.spool.size()) > 0) {
        this._ensureFlushTimer();
      } else {
        this._clearFlushTimer();
      }
    } catch {
      // ignore — timer management is best-effort
    }
  }

  private _ensureFlushTimer(): void {
    // When NetInfo drives flushing we don't need a polling timer (battery).
    if (this.netInfoUnsub) return;
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this._drain().catch((e) => {
        if (this.opts.debug) console.debug('uh-oh: scheduled flush failed', e);
      });
    }, FLUSH_INTERVAL_MS);
    // Don't keep a Node event loop alive purely for retries (harmless in RN).
    const t = this.flushTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  private _clearFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
