import type { EventEnvelope, Level, BreadcrumbLevel, JsonValue } from '@uh-oh/types';
import { Scope } from './scope.js';
import { BreadcrumbBuffer } from './breadcrumbs.js';
import { Spool, type AsyncStorageLike } from './spool.js';
import { sendEvent } from './transport.js';
import { parseDsn, type Dsn } from './dsn.js';
import { platform } from './platform.js';
import { installGlobalErrorHandler, installPromiseRejectionHandler } from './handlers.js';
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

function errorToException(
  err: unknown,
  mechanism: 'js-global' | 'js-promise' | 'js-manual',
): EventEnvelope['exception'] {
  if (err instanceof Error) {
    const frames = (err.stack ?? '')
      .split('\n')
      .slice(1)
      .map((line) => {
        const m = /at .+ \((.+):(\d+):(\d+)\)/.exec(line);
        return {
          inApp: true,
          ...(m
            ? {
                filename: m[1],
                lineno: parseInt(m[2] ?? '0', 10),
                colno: parseInt(m[3] ?? '0', 10),
              }
            : {}),
        };
      });
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

export class Client {
  readonly scope: Scope;
  private readonly breadcrumbs: BreadcrumbBuffer;
  private readonly spool: Spool;
  private readonly opts: InitOptions;
  private dsn: Dsn | null = null;
  private readonly noop: boolean;
  private uninstallHandlers: Array<() => void> = [];

  constructor(opts: InitOptions, storage?: AsyncStorageLike) {
    this.opts = opts;
    this.noop = platform() === 'ios';
    this.scope = new Scope();
    this.breadcrumbs = new BreadcrumbBuffer(opts.maxBreadcrumbs ?? 100);

    // Allow injecting storage for tests; fall back to AsyncStorage in RN environment
    const asyncStorage =
      storage ??
      ((): AsyncStorageLike => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('@react-native-async-storage/async-storage') as {
          default: AsyncStorageLike;
        };
        return mod.default;
      })();

    this.spool = new Spool(asyncStorage);
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

    this.uninstallHandlers.push(
      installGlobalErrorHandler((err) => capture(err, 'js-global')),
      installPromiseRejectionHandler((reason) => capture(reason, 'js-promise')),
    );

    if (this.opts.enableNative !== false) {
      void this._installNativeAndDrainPending();
    } else {
      void this._drain();
    }
  }

  private async _installNativeAndDrainPending(): Promise<void> {
    const bridge = nativeBridge();
    if (bridge) {
      await bridge.install({ debug: this.opts.debug ?? false });
      const reports = await bridge.getPendingReports();
      for (const r of reports) {
        const fullEnv = this._buildEnvelopeFromPartial(r);
        await this.spool.enqueue(fullEnv);
      }
    }
    await this._drain();
  }

  stop(): void {
    for (const fn of this.uninstallHandlers) fn();
    this.uninstallHandlers = [];
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
    const env = this._buildEnvelope(fakeErr, 'js-manual', level);
    if (!env) return '';
    const id = uuid();
    void this.spool.enqueue({ ...env }).then(() => void this._drain());
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
    const env = this._buildEnvelope(err, mechanism, 'error', ctx);
    if (!env) return '';
    const id = uuid();
    void this.spool.enqueue(env).then(() => void this._drain());
    return id;
  }

  private _buildEnvelope(
    err: unknown,
    mechanism: 'js-global' | 'js-promise' | 'js-manual',
    level: Level = 'error',
    ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): EventEnvelope | null {
    const snap = this.scope.snapshot();
    const { version, build } = parseRelease(this.opts.release);

    const mergedTags = {
      ...(snap.tags ?? {}),
      ...(ctx?.tags ?? {}),
    };

    const mergedContext = {
      ...(snap.context ?? {}),
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
      device: { osName: 'Android', osVersion: 'unknown' },
      ...(snap.user !== undefined ? { user: snap.user } : {}),
      ...(Object.keys(mergedTags).length > 0 ? { tags: mergedTags } : {}),
      ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
      ...(snap.fingerprint !== undefined ? { fingerprint: snap.fingerprint } : {}),
    };

    if (this.opts.beforeSend) {
      const result = this.opts.beforeSend(env);
      if (result === null) return null;
      return result;
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
  }
}
