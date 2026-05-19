import { Scope } from './scope.js';
import { BreadcrumbBuffer } from './breadcrumbs.js';
import { Spool } from './spool.js';
import { sendEvent } from './transport.js';
import { parseDsn } from './dsn.js';
import { platform } from './platform.js';
import { installGlobalErrorHandler, installPromiseRejectionHandler } from './handlers.js';
import { nativeBridge } from './native-bridge.js';
function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Minimal fallback for environments without crypto.randomUUID
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
function parseRelease(release) {
    const parts = release.split('+');
    return {
        version: parts[0] ?? release,
        build: parts[1] ?? '0',
    };
}
function errorToException(err, mechanism) {
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
    scope;
    breadcrumbs;
    spool;
    opts;
    dsn = null;
    noop;
    uninstallHandlers = [];
    constructor(opts, storage) {
        this.opts = opts;
        this.noop = platform() === 'ios';
        this.scope = new Scope();
        this.breadcrumbs = new BreadcrumbBuffer(opts.maxBreadcrumbs ?? 100);
        // Allow injecting storage for tests; fall back to AsyncStorage in RN environment
        const asyncStorage = storage ??
            (() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const mod = require('@react-native-async-storage/async-storage');
                return mod.default;
            })();
        this.spool = new Spool(asyncStorage);
    }
    start() {
        if (this.noop) {
            if (this.opts.debug)
                console.debug('uh-oh: iOS unsupported, no-op');
            return;
        }
        try {
            this.dsn = parseDsn(this.opts.dsn);
        }
        catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
            return;
        }
        const capture = (err, mechanism) => this._capture(err, mechanism);
        this.uninstallHandlers.push(installGlobalErrorHandler((err) => capture(err, 'js-global')), installPromiseRejectionHandler((reason) => capture(reason, 'js-promise')));
        if (this.opts.enableNative !== false) {
            void this._installNativeAndDrainPending();
        }
        else {
            void this._drain();
        }
    }
    async _installNativeAndDrainPending() {
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
    stop() {
        for (const fn of this.uninstallHandlers)
            fn();
        this.uninstallHandlers = [];
    }
    captureException(err, ctx) {
        if (this.noop)
            return '';
        return this._capture(err, 'js-manual', ctx);
    }
    captureMessage(msg, level = 'info') {
        if (this.noop)
            return '';
        const fakeErr = new Error(msg);
        fakeErr.name = 'Message';
        const env = this._buildEnvelope(fakeErr, 'js-manual', level);
        if (!env)
            return '';
        const id = uuid();
        void this.spool.enqueue({ ...env }).then(() => void this._drain());
        return id;
    }
    addBreadcrumb(b) {
        if (this.noop)
            return;
        this.breadcrumbs.add(b);
    }
    _capture(err, mechanism, ctx) {
        const env = this._buildEnvelope(err, mechanism, 'error', ctx);
        if (!env)
            return '';
        const id = uuid();
        void this.spool.enqueue(env).then(() => void this._drain());
        return id;
    }
    _buildEnvelope(err, mechanism, level = 'error', ctx) {
        const snap = this.scope.snapshot();
        const { version, build } = parseRelease(this.opts.release);
        const mergedTags = {
            ...(snap.tags ?? {}),
            ...(ctx?.tags ?? {}),
        };
        const mergedContext = {
            ...(snap.context ?? {}),
            ...(ctx?.extra ? { extra: ctx.extra } : {}),
        };
        const env = {
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
            if (result === null)
                return null;
            return result;
        }
        return env;
    }
    /**
     * Builds a full EventEnvelope from a partial report written by the native
     * crash handler. The native side provides exception, timestamp, and device;
     * this method fills in sdk, release, platform, level, breadcrumbs, and scope.
     */
    _buildEnvelopeFromPartial(partial) {
        const snap = this.scope.snapshot();
        const { version, build } = parseRelease(this.opts.release);
        const mergedTags = { ...(snap.tags ?? {}), ...(partial.tags ?? {}) };
        const mergedContext = { ...(snap.context ?? {}), ...(partial.context ?? {}) };
        const env = {
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
    async _drain() {
        if (!this.dsn)
            return;
        const { baseUrl, publicKey } = this.dsn;
        await this.spool.drain((env) => sendEvent(baseUrl, publicKey, env));
    }
}
//# sourceMappingURL=client.js.map