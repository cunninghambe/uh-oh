// @uh-oh/js - self-contained browser + Node crash-reporting client.
//
// This is ONE dependency-free TypeScript file by design: a vendor script
// copies it verbatim into consumer repos (see scripts/vendor-js-client.mjs).
// Constraints that shape the code below:
//   * ZERO imports. The minimal envelope wire types are inlined as local
//     interfaces (the real Zod schemas live in @uh-oh/types; the TESTS import
//     them to validate what this file produces).
//   * Must compile under strict TS in foreign repos where the DOM lib AND the
//     Node lib may both be absent, so every runtime global (window, process,
//     fetch, localStorage, ...) is reached through a locally-typed view of
//     globalThis rather than by referencing an ambient global type.
//   * The public API must NEVER throw. Every entry point is wrapped, handler
//     installs are guarded, the internal pipeline has a re-entrancy guard, and
//     async work is catch-all'd so it can never surface an unhandled rejection
//     (which our own promise handler would otherwise re-capture in a loop).
//   * Usage analytics (trackPageview/trackEvent) is a second, INDEPENDENT
//     pipeline from the crash queue above: its own bounded queue, its own
//     batching timer, and no retry/spool on send failure. It is lossy by
//     design - low-value, high-volume data - and, per privacy requirements,
//     this file never mints, stores, or sends any identifier of its own (no
//     cookies, no localStorage id); it only ships the event payloads the
//     caller/browser hands it, and identity is established server-side.
//
// NOTE: this file must contain no U+2014 (em dash) characters - one consumer
// repo lints for them and the file is vendored in verbatim. Use hyphens.
// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------
const SDK_NAME = '@uh-oh/js';
const SDK_VERSION = '0.5.0';
const SPOOL_KEY = 'uh-oh:spool';
const SPOOL_FILE = 'uh-oh-spool.json';
const SPOOL_DEBOUNCE_MS = 1_000;
const MAX_QUEUE = 50;
const MAX_SPOOL_BYTES = 500_000;
const WIRE_BREADCRUMB_MAX = 100;
const DEFAULT_MAX_BREADCRUMBS = 100;
const RETRY_INTERVAL_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
const UNCAUGHT_FLUSH_MS = 2_000;
const TYPE_MAX = 256;
const VALUE_MAX = 4096;
const CATEGORY_MAX = 64;
const MESSAGE_MAX = 1024;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
// -- usage analytics: batching + validation (mirrors CONTRACT U-IN server-side) --
const ANALYTICS_MAX_QUEUE = 20;
const ANALYTICS_DEBOUNCE_MS = 5_000;
const USAGE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const USAGE_PATH_MAX = 512;
const USAGE_REFERRER_MAX = 512;
const USAGE_PROPS_MAX_KEYS = 10;
const USAGE_PROP_KEY_MAX = 64;
const USAGE_PROP_VALUE_MAX = 256;
const G = globalThis;
// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------
function safeStr(v, max) {
    let s;
    try {
        s = typeof v === 'string' ? v : String(v);
    }
    catch {
        s = '';
    }
    return s.length > max ? s.slice(0, max) : s;
}
function genId(cryptoObj) {
    try {
        if (cryptoObj && typeof cryptoObj.randomUUID === 'function')
            return cryptoObj.randomUUID();
    }
    catch {
        // fall through to the manual id
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
/**
 * Resolves a usable `node:fs` via a guarded `require`, reached through the
 * globalThis view (same discipline as every other runtime global here). Returns
 * undefined - never throws - when `require` or the module is unavailable
 * (browsers, or an ESM host with no reachable `require`), which disables the
 * disk spool silently.
 */
function loadFs() {
    try {
        const req = G.require;
        if (typeof req !== 'function')
            return undefined;
        const mod = req('node:fs');
        if (mod &&
            typeof mod.mkdirSync === 'function' &&
            typeof mod.writeFileSync === 'function' &&
            typeof mod.renameSync === 'function' &&
            typeof mod.readFileSync === 'function') {
            return mod;
        }
    }
    catch {
        // node:fs unavailable; the disk spool stays disabled.
    }
    return undefined;
}
/**
 * Parses `http(s)://<publicKey>@<host>[:port][/path]`. Returns null (never
 * throws) for absent, empty, or malformed input so the caller can no-op.
 */
export function parseDsn(dsn) {
    if (!dsn || typeof dsn !== 'string' || dsn.trim() === '')
        return null;
    const UrlCtor = G.URL;
    if (!UrlCtor)
        return null;
    let u;
    try {
        u = new UrlCtor(dsn);
    }
    catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        return null;
    const publicKey = u.username;
    if (!publicKey)
        return null;
    const port = u.port ? `:${u.port}` : '';
    let path = u.pathname || '';
    if (path === '/')
        path = '';
    if (path.endsWith('/'))
        path = path.slice(0, -1);
    const baseUrl = `${u.protocol}//${u.hostname}${port}${path}`;
    return { publicKey, baseUrl, ingestUrl: `${baseUrl}/ingest/${publicKey}` };
}
function parseRelease(release) {
    const raw = typeof release === 'string' ? release : '';
    const plus = raw.indexOf('+');
    const version = plus >= 0 ? raw.slice(0, plus) : raw;
    const build = plus >= 0 ? raw.slice(plus + 1) : '';
    return {
        version: safeStr(version || raw || '0.0.0', 64),
        build: safeStr(build || '0', 64),
    };
}
function toInt(s) {
    if (s === undefined)
        return undefined;
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function makeFrame(fn, file, ln, col) {
    const inApp = !(file && file.includes('node_modules'));
    return {
        inApp,
        ...(fn ? { function: safeStr(fn, 512) } : {}),
        ...(file ? { filename: safeStr(file, 1024) } : {}),
        ...(ln !== undefined ? { lineno: ln } : {}),
        ...(col !== undefined ? { colno: col } : {}),
    };
}
/**
 * Parses one stack line into a StackFrame. Handles V8/Node (`at fn (f:l:c)`
 * and `at f:l:c`, plus Hermes `address at`) and Firefox/Safari (`fn@f:l:c`).
 * Unmatched lines yield a location-less in-app frame.
 */
function parseStackLine(line) {
    const v8Fn = /^\s*at\s+(.+?)\s+\((?:address at\s+)?(.+):(\d+):(\d+)\)\s*$/.exec(line);
    if (v8Fn)
        return makeFrame(v8Fn[1], v8Fn[2], toInt(v8Fn[3]), toInt(v8Fn[4]));
    const v8Anon = /^\s*at\s+(?:address at\s+)?(.+):(\d+):(\d+)\s*$/.exec(line);
    if (v8Anon)
        return makeFrame(undefined, v8Anon[1], toInt(v8Anon[2]), toInt(v8Anon[3]));
    const ff = /^\s*([^@]*)@(.+):(\d+):(\d+)\s*$/.exec(line);
    if (ff) {
        const fn = (ff[1] ?? '').trim();
        return makeFrame(fn || undefined, ff[2], toInt(ff[3]), toInt(ff[4]));
    }
    return { inApp: true };
}
function isErrorLike(err) {
    return typeof err === 'object' && err !== null && 'message' in err;
}
function errorToException(err, mechanism) {
    if (err instanceof Error || isErrorLike(err)) {
        const e = err;
        const stack = typeof e.stack === 'string' ? e.stack : '';
        const frames = stack ? stack.split('\n').slice(1).map(parseStackLine) : [];
        return {
            type: safeStr(typeof e.name === 'string' && e.name ? e.name : 'Error', TYPE_MAX),
            value: safeStr(e.message, VALUE_MAX),
            stacktrace: frames.slice(0, 500),
            mechanism,
        };
    }
    return {
        type: 'UnknownError',
        value: safeStr(err, VALUE_MAX),
        stacktrace: [],
        mechanism,
    };
}
function parseUserAgent(ua) {
    if (!ua)
        return { osName: 'browser', osVersion: 'unknown' };
    const win = /Windows NT ([0-9._]+)/.exec(ua);
    if (win)
        return { osName: 'Windows', osVersion: safeStr(win[1] ?? 'unknown', 64) };
    const mac = /Mac OS X ([0-9_.]+)/.exec(ua);
    if (mac)
        return {
            osName: 'macOS',
            osVersion: safeStr((mac[1] ?? '').replace(/_/g, '.') || 'unknown', 64),
        };
    const android = /Android ([0-9._]+)/.exec(ua);
    if (android)
        return { osName: 'Android', osVersion: safeStr(android[1] ?? 'unknown', 64) };
    const ios = /(?:iPhone|iPad|iPod).*?OS ([0-9_]+)/.exec(ua);
    if (ios)
        return {
            osName: 'iOS',
            osVersion: safeStr((ios[1] ?? '').replace(/_/g, '.') || 'unknown', 64),
        };
    if (/Linux/.test(ua))
        return { osName: 'Linux', osVersion: 'unknown' };
    return { osName: 'browser', osVersion: 'unknown' };
}
// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------
export class Client {
    opts;
    runtime;
    maxBreadcrumbs;
    // Resolved runtime seams.
    fetchFn;
    proc;
    win;
    doc;
    nav;
    storage;
    cryptoObj;
    location;
    history;
    now;
    setTimeoutFn;
    clearTimeoutFn;
    setIntervalFn;
    clearIntervalFn;
    dsn = null;
    noop;
    closed = false;
    // Scope.
    user = null;
    tags = {};
    ctx = {};
    fingerprint = null;
    breadcrumbs = [];
    // Queue + guards.
    queue = [];
    capturing = false;
    drainInFlight = null;
    drainRequested = false;
    retryTimer = null;
    // Teardown + node exit semantics.
    uninstallers = [];
    wasOnlyUncaughtListener = false;
    // Usage analytics: independent queue, batching timer, and state - see the
    // "analytics (usage tracking)" section below.
    analyticsQueue = [];
    analyticsTimer = null;
    referrerSent = false;
    lastAutoPath;
    // Node disk spool (opts.spoolDir; node runtime only). All undefined unless a
    // spoolDir was given on a node runtime AND a node:fs was resolved.
    fs;
    spoolDir;
    spoolFile;
    spoolTmp;
    spoolTimer = null;
    spoolDirty = false;
    constructor(opts, deps = {}) {
        this.opts = opts;
        this.fetchFn = pick(deps.fetchFn, G.fetch);
        this.proc = pick(deps.proc, G.process);
        this.doc = pick(deps.doc, G.document);
        this.nav = pick(deps.navigator, G.navigator);
        this.storage = pick(deps.storage, G.localStorage);
        this.cryptoObj = pick(deps.cryptoObj, G.crypto);
        this.location = pick(deps.location, G.location);
        this.history = pick(deps.history, G.history);
        this.win =
            deps.win !== undefined
                ? deps.win === null
                    ? undefined
                    : deps.win
                : G.window !== undefined && typeof G.addEventListener === 'function'
                    ? globalThis
                    : undefined;
        this.now = deps.now ?? (() => Date.now());
        this.setTimeoutFn = deps.setTimeoutFn ?? G.setTimeout ?? (() => 0);
        this.clearTimeoutFn = deps.clearTimeoutFn ?? G.clearTimeout ?? (() => undefined);
        this.setIntervalFn = deps.setIntervalFn ?? G.setInterval ?? (() => 0);
        this.clearIntervalFn = deps.clearIntervalFn ?? G.clearInterval ?? (() => undefined);
        const detected = this.win !== undefined && this.doc !== undefined ? 'browser' : 'node';
        this.runtime = opts.runtime ?? detected;
        const spoolDir = typeof opts.spoolDir === 'string' && opts.spoolDir.length > 0 ? opts.spoolDir : undefined;
        if (this.runtime === 'node' && spoolDir !== undefined) {
            this.spoolDir = spoolDir;
            // Node accepts forward slashes on every platform, so a POSIX join is safe
            // here and avoids pulling in node:path.
            const sep = /[\\/]$/.test(spoolDir) ? '' : '/';
            this.spoolFile = `${spoolDir}${sep}${SPOOL_FILE}`;
            this.spoolTmp = `${this.spoolFile}.tmp`;
            this.fs = deps.fs !== undefined ? (deps.fs === null ? undefined : deps.fs) : loadFs();
        }
        else {
            this.spoolDir = undefined;
            this.spoolFile = undefined;
            this.spoolTmp = undefined;
            this.fs = undefined;
        }
        const max = opts.maxBreadcrumbs;
        this.maxBreadcrumbs =
            typeof max === 'number' && max >= 0 ? Math.floor(max) : DEFAULT_MAX_BREADCRUMBS;
        this.dsn = parseDsn(opts.dsn);
        this.noop = this.dsn === null;
    }
    log(level, msg, err) {
        if (!this.opts.debug && level === 'debug')
            return;
        try {
            const c = G.console;
            const line = `uh-oh: ${msg}`;
            if (level === 'error' && c && typeof c.error === 'function')
                c.error(line, err);
            else if (level === 'warn' && c && typeof c.warn === 'function')
                c.warn(line, err);
            else if (c && typeof c.debug === 'function')
                c.debug(line, err);
        }
        catch {
            // logging must never throw
        }
    }
    install() {
        if (this.noop) {
            if (this.opts.debug)
                this.log('debug', 'no dsn provided; SDK disabled (no-op)');
            return;
        }
        this.restore();
        if (this.runtime === 'browser') {
            this.installBrowserHandlers();
            this.installLifecycleFlush();
            this.installAutoAnalytics();
        }
        else {
            this.installNodeHandlers();
        }
        // Restored spool may already hold events.
        void this.drainQueue();
    }
    // ---- handlers ----------------------------------------------------------
    installBrowserHandlers() {
        const target = this.win;
        if (!target || typeof target.addEventListener !== 'function')
            return;
        try {
            const onError = (ev) => {
                const e = ev;
                const err = e.error !== undefined && e.error !== null ? e.error : (e.message ?? 'Error');
                this.captureWithException(errorToException(err, 'js-global'), 'error');
                // Never preventDefault: coexist with the app's own handlers.
            };
            const onRejection = (ev) => {
                const e = ev;
                this.captureWithException(errorToException(e.reason, 'js-promise'), 'error');
            };
            target.addEventListener('error', onError);
            target.addEventListener('unhandledrejection', onRejection);
            this.uninstallers.push(() => {
                try {
                    target.removeEventListener?.('error', onError);
                    target.removeEventListener?.('unhandledrejection', onRejection);
                }
                catch {
                    // best-effort teardown
                }
            });
        }
        catch (e) {
            this.log('debug', 'failed to install browser handlers', e);
        }
    }
    installLifecycleFlush() {
        const target = this.win;
        if (!target || typeof target.addEventListener !== 'function')
            return;
        try {
            const onHide = () => {
                this.beaconFlush();
                this.beaconFlushAnalytics();
            };
            const onVisibility = () => {
                if (this.doc && this.doc.visibilityState === 'hidden') {
                    this.beaconFlush();
                    this.beaconFlushAnalytics();
                }
            };
            target.addEventListener('pagehide', onHide);
            target.addEventListener('visibilitychange', onVisibility);
            this.uninstallers.push(() => {
                try {
                    target.removeEventListener?.('pagehide', onHide);
                    target.removeEventListener?.('visibilitychange', onVisibility);
                }
                catch {
                    // best-effort teardown
                }
            });
        }
        catch (e) {
            this.log('debug', 'failed to install lifecycle flush', e);
        }
    }
    installNodeHandlers() {
        const p = this.proc;
        if (!p || typeof p.on !== 'function')
            return;
        try {
            // Capture how many userland uncaughtException listeners exist BEFORE we
            // add ours. If none, Node would have crashed the process on an uncaught
            // error; our listener suppresses that default, so we must replicate it
            // (log + exit 1) after a best-effort flush. If other listeners exist,
            // they own the decision - we only capture and never exit (never steal
            // another handler's choice, never keep a corrupted process alive).
            const existing = typeof p.listeners === 'function' ? p.listeners('uncaughtException') : [];
            this.wasOnlyUncaughtListener = existing.length === 0;
            const onUncaught = (err) => this.onUncaughtException(err);
            const onRejection = (reason) => {
                this.captureWithException(errorToException(reason, 'js-promise'), 'error');
                void this.drainQueue();
            };
            p.on('uncaughtException', onUncaught);
            p.on('unhandledRejection', onRejection);
            this.uninstallers.push(() => {
                const remove = p.off ?? p.removeListener;
                try {
                    remove?.call(p, 'uncaughtException', onUncaught);
                    remove?.call(p, 'unhandledRejection', onRejection);
                }
                catch {
                    // best-effort teardown
                }
            });
        }
        catch (e) {
            this.log('debug', 'failed to install node handlers', e);
        }
    }
    async onUncaughtException(err) {
        try {
            this.captureWithException(errorToException(err, 'js-global'), 'error');
        }
        catch {
            // capture guarded internally; nothing to do
        }
        try {
            await this.flushWithTimeout(UNCAUGHT_FLUSH_MS);
        }
        catch {
            // best-effort flush
        }
        // Anything that could not be sent gets spooled so the next start drains it.
        this.flushSpool(true);
        if (this.wasOnlyUncaughtListener && !this.closed) {
            this.writeStderr(err);
            try {
                this.proc?.exit?.(1);
            }
            catch {
                // exit unavailable; nothing else we can safely do
            }
        }
    }
    writeStderr(err) {
        let msg;
        if (err instanceof Error || isErrorLike(err)) {
            const e = err;
            msg =
                typeof e.stack === 'string'
                    ? e.stack
                    : `${SDK_NAME} uncaughtException: ${String(e.message)}`;
        }
        else {
            msg = `${SDK_NAME} uncaughtException: ${String(err)}`;
        }
        try {
            const w = this.proc?.stderr?.write;
            if (typeof w === 'function') {
                w.call(this.proc?.stderr, msg + '\n');
                return;
            }
        }
        catch {
            // fall through to console
        }
        this.log('error', msg);
    }
    // ---- capture pipeline --------------------------------------------------
    captureException(err, opts) {
        if (this.noop || this.closed)
            return '';
        const mechanism = opts?.mechanism ?? 'js-manual';
        const level = opts?.level ?? 'error';
        return this.captureWithException(errorToException(err, mechanism), level);
    }
    captureMessage(msg, level = 'info') {
        if (this.noop || this.closed)
            return '';
        const exception = {
            type: 'Message',
            value: safeStr(msg, VALUE_MAX),
            stacktrace: [],
            mechanism: 'js-manual',
        };
        return this.captureWithException(exception, level);
    }
    captureWithException(exception, level) {
        if (this.noop || this.closed)
            return '';
        // Re-entrancy guard: an error thrown by our own pipeline must be dropped,
        // not fed back through capture (which would loop).
        if (this.capturing) {
            this.log('debug', 'dropped re-entrant capture');
            return '';
        }
        this.capturing = true;
        try {
            const id = genId(this.cryptoObj);
            const env = this.buildEnvelope(exception, level, id);
            const finalEnv = this.applyBeforeSend(env);
            if (finalEnv === null)
                return '';
            this.enqueue(finalEnv);
            void this.drainQueue();
            return id;
        }
        catch (e) {
            this.log('debug', 'capture failed internally', e);
            return '';
        }
        finally {
            this.capturing = false;
        }
    }
    applyBeforeSend(env) {
        const bs = this.opts.beforeSend;
        if (!bs)
            return env;
        try {
            const r = bs(env);
            return r === null ? null : r;
        }
        catch (e) {
            // A throwing beforeSend must not drop the crash: send it unmodified.
            this.log('debug', 'beforeSend threw; sending unmodified event', e);
            return env;
        }
    }
    buildEnvelope(exception, level, id) {
        const ctx = { ...this.ctx };
        if (this.opts.environment !== undefined)
            ctx['environment'] = this.opts.environment;
        ctx['eventId'] = id;
        const hasTags = Object.keys(this.tags).length > 0;
        const hasCtx = Object.keys(ctx).length > 0;
        return {
            sdk: { name: SDK_NAME, version: SDK_VERSION },
            timestamp: new Date(this.now()).toISOString(),
            platform: this.runtime === 'browser' ? 'web' : 'node',
            release: parseRelease(this.opts.release),
            level,
            exception,
            breadcrumbs: this.breadcrumbs.slice(-WIRE_BREADCRUMB_MAX),
            device: this.buildDevice(),
            ...(this.user ? { user: this.user } : {}),
            ...(hasTags ? { tags: { ...this.tags } } : {}),
            ...(hasCtx ? { context: ctx } : {}),
            ...(this.fingerprint ? { fingerprint: this.fingerprint.slice(0, 8) } : {}),
        };
    }
    buildDevice() {
        if (this.runtime === 'node') {
            const p = this.proc;
            const osName = p && typeof p.platform === 'string' && p.platform ? p.platform : 'node';
            const osVersion = p && typeof p.version === 'string' && p.version ? p.version : 'unknown';
            const arch = p && typeof p.arch === 'string' && p.arch ? p.arch : undefined;
            return {
                osName: safeStr(osName, CATEGORY_MAX),
                osVersion: safeStr(osVersion, CATEGORY_MAX),
                ...(arch ? { arch: safeStr(arch, 32) } : {}),
            };
        }
        const nav = this.nav;
        const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : '';
        const { osName, osVersion } = parseUserAgent(ua);
        const locale = nav && typeof nav.language === 'string' && nav.language ? nav.language : undefined;
        const timezone = this.resolveTimezone();
        return {
            osName: safeStr(osName, CATEGORY_MAX),
            osVersion: safeStr(osVersion, CATEGORY_MAX),
            ...(locale ? { locale: safeStr(locale, 32) } : {}),
            ...(timezone ? { timezone: safeStr(timezone, CATEGORY_MAX) } : {}),
        };
    }
    resolveTimezone() {
        try {
            const intl = G.Intl;
            if (intl && typeof intl.DateTimeFormat === 'function') {
                const tz = new intl.DateTimeFormat().resolvedOptions().timeZone;
                return tz || undefined;
            }
        }
        catch {
            // Intl unavailable
        }
        return undefined;
    }
    // ---- scope -------------------------------------------------------------
    addBreadcrumb(b) {
        if (this.noop || this.closed)
            return;
        try {
            const crumb = {
                category: safeStr(b.category || 'default', CATEGORY_MAX),
                message: safeStr(b.message ?? '', MESSAGE_MAX),
                level: b.level ?? 'info',
                ts: new Date(this.now()).toISOString(),
                ...(b.data !== undefined ? { data: b.data } : {}),
            };
            this.breadcrumbs.push(crumb);
            while (this.breadcrumbs.length > this.maxBreadcrumbs)
                this.breadcrumbs.shift();
        }
        catch (e) {
            this.log('debug', 'addBreadcrumb failed', e);
        }
    }
    setUser(u) {
        this.user = u;
    }
    setContext(key, value) {
        if (value === null)
            delete this.ctx[key];
        else
            this.ctx[key] = value;
    }
    setTag(key, value) {
        if (value === null)
            delete this.tags[key];
        else
            this.tags[key] = value;
    }
    setFingerprint(parts) {
        this.fingerprint = parts;
    }
    // ---- check-in (dead-man's-switch monitors) ------------------------------
    /**
     * Fire-and-forget check-in ping for a named monitor. One attempt only -
     * never queued, spooled, or retried, since a late check-in is worthless.
     * Silent no-op when uninitialised/no dsn; an invalid slug is dropped (debug
     * log only). Never throws. No re-entrancy guard needed: unlike capture,
     * this has no pipeline for a failure to loop back through.
     */
    checkIn(slug, opts) {
        if (this.noop || this.closed)
            return;
        try {
            const dsn = this.dsn;
            const fetchFn = this.fetchFn;
            if (!dsn || !fetchFn)
                return;
            if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
                this.log('debug', `checkIn: invalid slug ${JSON.stringify(safeStr(slug, 80))}; dropped`);
                return;
            }
            let url = `${dsn.ingestUrl}/check-in/${slug}`;
            const interval = opts?.intervalMinutes;
            if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
                url += `?intervalMinutes=${String(Math.floor(interval))}`;
            }
            void this.sendCheckIn(url);
        }
        catch (e) {
            this.log('debug', 'checkIn failed internally', e);
        }
    }
    /**
     * Single-attempt POST for a check-in ping. Swallows every failure (network
     * error, timeout, non-2xx) - there is no queue or retry timer for check-ins.
     */
    async sendCheckIn(url) {
        const fetchFn = this.fetchFn;
        if (!fetchFn)
            return;
        let controller;
        try {
            const Ctor = G.AbortController;
            if (Ctor)
                controller = new Ctor();
        }
        catch {
            controller = undefined;
        }
        const timer = controller
            ? this.setTimeoutFn(() => {
                try {
                    controller?.abort();
                }
                catch {
                    // ignore
                }
            }, SEND_TIMEOUT_MS)
            : null;
        try {
            const init = {
                method: 'POST',
                headers: {},
                body: '',
                ...(this.runtime === 'browser' ? { keepalive: true } : {}),
                ...(controller ? { signal: controller.signal } : {}),
            };
            await fetchFn(url, init);
        }
        catch {
            // one attempt only - never retried, never throws
        }
        finally {
            if (timer !== null)
                this.clearTimeoutFn(timer);
        }
    }
    // ---- queue + transport -------------------------------------------------
    enqueue(env) {
        this.queue.push({ id: genId(this.cryptoObj), env });
        while (this.queue.length > MAX_QUEUE) {
            this.queue.shift();
            this.log('debug', 'queue over cap (50); dropped oldest event');
        }
        this.persist();
    }
    async sendOne(env) {
        if (!this.dsn)
            return { ok: false };
        const fetchFn = this.fetchFn;
        if (!fetchFn)
            return { ok: false };
        let controller;
        try {
            const Ctor = G.AbortController;
            if (Ctor)
                controller = new Ctor();
        }
        catch {
            controller = undefined;
        }
        const timer = controller
            ? this.setTimeoutFn(() => {
                try {
                    controller?.abort();
                }
                catch {
                    // ignore
                }
            }, SEND_TIMEOUT_MS)
            : null;
        try {
            const init = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(env),
                ...(this.runtime === 'browser' ? { keepalive: true } : {}),
                ...(controller ? { signal: controller.signal } : {}),
            };
            const res = await fetchFn(this.dsn.ingestUrl, init);
            return { ok: res.ok, status: res.status };
        }
        catch {
            return { ok: false };
        }
        finally {
            if (timer !== null)
                this.clearTimeoutFn(timer);
        }
    }
    /** Coalescing drain: at most one runs; a request mid-drain triggers one more. */
    drainQueue() {
        if (this.drainInFlight) {
            this.drainRequested = true;
            return this.drainInFlight;
        }
        this.drainInFlight = this.drainLoop().finally(() => {
            this.drainInFlight = null;
        });
        return this.drainInFlight;
    }
    async drainLoop() {
        do {
            this.drainRequested = false;
            try {
                await this.drainOnce();
            }
            catch (e) {
                this.log('debug', 'drain failed', e);
                break;
            }
        } while (this.drainRequested && this.queue.length > 0);
        this.updateRetryTimer();
    }
    async drainOnce() {
        if (!this.dsn)
            return;
        while (this.queue.length > 0 && !this.closed) {
            const item = this.queue[0];
            if (!item)
                break;
            const res = await this.sendOne(item.env);
            if (res.ok) {
                this.queue.shift();
                this.persist();
                continue;
            }
            if (res.status === 413) {
                // Payload too large: trim breadcrumbs to last 50 and retry once.
                const trimmed = {
                    ...item.env,
                    breadcrumbs: item.env.breadcrumbs.slice(-50),
                };
                const retry = await this.sendOne(trimmed);
                if (retry.ok) {
                    this.queue.shift();
                    this.persist();
                    continue;
                }
                if (retry.status === 413) {
                    this.log('debug', 'event dropped after second 413');
                    this.queue.shift();
                    this.persist();
                    continue;
                }
                // Transient failure after trimming: keep the TRIMMED event and stop.
                item.env = trimmed;
                this.queue[0] = item;
                this.persist();
                break;
            }
            // Other 4xx (not 429): permanent, drop and continue.
            if (res.status !== undefined && res.status >= 400 && res.status < 500 && res.status !== 429) {
                this.log('debug', `event dropped on ${String(res.status)} response`);
                this.queue.shift();
                this.persist();
                continue;
            }
            // Network error, 5xx, or 429: retain and stop; the retry timer picks up.
            break;
        }
    }
    updateRetryTimer() {
        if (this.queue.length > 0 && !this.closed) {
            this.ensureRetryTimer();
        }
        else {
            this.clearRetryTimer();
        }
    }
    ensureRetryTimer() {
        if (this.retryTimer !== null)
            return;
        this.retryTimer = this.setIntervalFn(() => {
            void this.drainQueue();
        }, RETRY_INTERVAL_MS);
        // Do not keep a Node event loop alive purely for retries.
        try {
            const t = this.retryTimer;
            if (t && typeof t.unref === 'function')
                t.unref();
        }
        catch {
            // unref unavailable (browser); harmless
        }
    }
    clearRetryTimer() {
        if (this.retryTimer !== null) {
            try {
                this.clearIntervalFn(this.retryTimer);
            }
            catch {
                // ignore
            }
            this.retryTimer = null;
        }
    }
    // ---- browser persistence ----------------------------------------------
    persist() {
        if (this.runtime === 'browser') {
            this.persistBrowser();
            return;
        }
        this.scheduleSpool();
    }
    persistBrowser() {
        const storage = this.storage;
        if (!storage)
            return;
        try {
            let items = this.queue.slice(-MAX_QUEUE);
            let serialized = JSON.stringify(items);
            while (serialized.length > MAX_SPOOL_BYTES && items.length > 1) {
                items = items.slice(1);
                serialized = JSON.stringify(items);
            }
            if (items.length === 0)
                storage.removeItem(SPOOL_KEY);
            else
                storage.setItem(SPOOL_KEY, serialized);
        }
        catch (e) {
            this.log('debug', 'spool persist failed', e);
        }
    }
    restore() {
        if (this.runtime === 'browser') {
            this.restoreBrowser();
            return;
        }
        this.restoreNode();
    }
    restoreBrowser() {
        const storage = this.storage;
        if (!storage)
            return;
        let raw = null;
        try {
            raw = storage.getItem(SPOOL_KEY);
        }
        catch (e) {
            this.log('debug', 'spool read failed', e);
            return;
        }
        if (!raw)
            return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            this.log('debug', 'spool JSON parse failed; discarding corrupt spool');
            this.safeRemoveSpool();
            return;
        }
        if (!Array.isArray(parsed)) {
            this.log('debug', 'spool was not an array; discarding corrupt spool');
            this.safeRemoveSpool();
            return;
        }
        // Restored events are older, so they go in front, then cap.
        this.queue = [...this.coerceEntries(parsed), ...this.queue].slice(-MAX_QUEUE);
    }
    safeRemoveSpool() {
        try {
            this.storage?.removeItem(SPOOL_KEY);
        }
        catch {
            // ignore
        }
    }
    /** Validates raw spool entries; drops (with a debug log) any malformed one. */
    coerceEntries(parsed) {
        const valid = [];
        for (const raw of parsed) {
            const it = raw;
            if (it &&
                typeof it === 'object' &&
                typeof it.id === 'string' &&
                it.env !== null &&
                typeof it.env === 'object') {
                valid.push({ id: it.id, env: it.env });
            }
            else {
                this.log('debug', 'discarded malformed spool entry');
            }
        }
        return valid;
    }
    // ---- node disk spool ---------------------------------------------------
    /** Debounced (~1s) request to write the queue to disk. No-op without spool. */
    scheduleSpool() {
        if (this.runtime !== 'node' || !this.fs || !this.spoolFile)
            return;
        this.spoolDirty = true;
        if (this.spoolTimer !== null)
            return;
        this.spoolTimer = this.setTimeoutFn(() => {
            this.spoolTimer = null;
            this.flushSpool();
        }, SPOOL_DEBOUNCE_MS);
        // Do not keep a Node event loop alive purely for a pending spool write.
        try {
            const t = this.spoolTimer;
            if (t && typeof t.unref === 'function')
                t.unref();
        }
        catch {
            // unref unavailable; harmless
        }
    }
    /**
     * Writes the queue to `<spoolDir>/uh-oh-spool.json` atomically: serialize to
     * a sibling `.tmp` file then rename over the target, so a concurrent reader
     * never sees a partially written file. Force-flushes bypass the dirty check
     * (used on close and on the uncaught-exception exit path). Never throws.
     */
    flushSpool(force = false) {
        if (this.runtime !== 'node')
            return;
        const fs = this.fs;
        const file = this.spoolFile;
        const tmp = this.spoolTmp;
        const dir = this.spoolDir;
        if (!fs || !file || !tmp || dir === undefined)
            return;
        if (!force && !this.spoolDirty)
            return;
        this.spoolDirty = false;
        try {
            let items = this.queue.slice(-MAX_QUEUE);
            let serialized = JSON.stringify(items);
            while (serialized.length > MAX_SPOOL_BYTES && items.length > 1) {
                items = items.slice(1);
                serialized = JSON.stringify(items);
            }
            if (items.length === 0) {
                this.safeUnlink(file);
                return;
            }
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(tmp, serialized);
            fs.renameSync(tmp, file);
        }
        catch (e) {
            this.log('debug', 'node spool persist failed', e);
            // Leave no half-written tmp file behind on failure.
            this.safeUnlink(tmp);
        }
    }
    restoreNode() {
        const fs = this.fs;
        const file = this.spoolFile;
        if (!fs || !file)
            return;
        let raw;
        try {
            if (typeof fs.existsSync === 'function' && !fs.existsSync(file))
                return;
            raw = fs.readFileSync(file, 'utf8');
        }
        catch (e) {
            // Missing or unreadable file: nothing to restore.
            this.log('debug', 'node spool read failed', e);
            return;
        }
        if (!raw)
            return;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            this.log('debug', 'node spool JSON parse failed; discarding corrupt spool');
            this.safeUnlink(file);
            return;
        }
        if (!Array.isArray(parsed)) {
            this.log('debug', 'node spool was not an array; discarding corrupt spool');
            this.safeUnlink(file);
            return;
        }
        this.queue = [...this.coerceEntries(parsed), ...this.queue].slice(-MAX_QUEUE);
    }
    safeUnlink(path) {
        try {
            this.fs?.unlinkSync?.(path);
        }
        catch {
            // best-effort
        }
    }
    clearSpoolTimer() {
        if (this.spoolTimer !== null) {
            try {
                this.clearTimeoutFn(this.spoolTimer);
            }
            catch {
                // ignore
            }
            this.spoolTimer = null;
        }
    }
    beaconFlush() {
        if (!this.dsn || this.queue.length === 0)
            return;
        const nav = this.nav;
        const beacon = nav && typeof nav.sendBeacon === 'function' ? nav.sendBeacon.bind(nav) : null;
        if (!beacon) {
            void this.drainQueue();
            return;
        }
        const remaining = [];
        for (const item of this.queue) {
            let ok = false;
            try {
                ok = beacon(this.dsn.ingestUrl, this.beaconBody(item.env));
            }
            catch {
                ok = false;
            }
            if (!ok)
                remaining.push(item);
        }
        this.queue = remaining;
        this.persist();
    }
    beaconBody(payload) {
        const json = JSON.stringify(payload);
        try {
            const BlobCtorRef = G.Blob;
            if (BlobCtorRef)
                return new BlobCtorRef([json], { type: 'application/json' });
        }
        catch {
            // fall through to string
        }
        return json;
    }
    // ---- analytics (usage tracking) ----------------------------------------
    //
    // Independent of the crash queue above: its own bounded queue (cap 20),
    // its own 5s debounce-after-first-enqueue batching timer, and NO retry or
    // spool on send failure - a dropped analytics batch is simply gone. This
    // is intentional: usage analytics is high-volume, low-value-per-event data
    // where holding memory/disk to retry a failed batch is the wrong trade,
    // unlike a crash report. Never mints/stores/sends any identifier of its
    // own; identity is entirely server-side (see CONTRACT U-IN).
    /**
     * Records a pageview. Browser: defaults `path` to `location.pathname`.
     * Node: always dropped (with a debug log) - pageviews are a browser
     * concept. Silent no-op when uninitialised/no dsn/closed. Never throws.
     */
    trackPageview(path) {
        if (this.noop || this.closed)
            return;
        try {
            if (this.runtime === 'node') {
                this.log('debug', 'trackPageview: dropped on node runtime (pageviews are a browser concept)');
                return;
            }
            this.sendPageview(path);
        }
        catch (e) {
            this.log('debug', 'trackPageview failed internally', e);
        }
    }
    /**
     * Records a named custom event with optional props. Works on both
     * runtimes. Validates client-side against the same shape the server
     * enforces (name regex, <=10 props, key/value length caps); any violation
     * drops the WHOLE call (not a partial/truncated send) with a debug log, so
     * the client never ships something the server would reject anyway. Never
     * throws.
     */
    trackEvent(name, props) {
        if (this.noop || this.closed)
            return;
        try {
            if (typeof name !== 'string' || !USAGE_NAME_RE.test(name)) {
                this.log('debug', `trackEvent: invalid name ${JSON.stringify(safeStr(name, 80))}; dropped`);
                return;
            }
            const validated = this.validateProps(props);
            if (!validated.ok)
                return; // reason already logged by validateProps
            const evt = {
                type: 'event',
                ts: this.now(),
                name,
                ...(validated.props ? { props: validated.props } : {}),
            };
            this.enqueueAnalytics(evt);
        }
        catch (e) {
            this.log('debug', 'trackEvent failed internally', e);
        }
    }
    resolvePath(explicitPath) {
        if (typeof explicitPath === 'string' && explicitPath.length > 0)
            return explicitPath;
        const loc = this.location;
        return loc && typeof loc.pathname === 'string' ? loc.pathname : '';
    }
    /**
     * Builds and enqueues one pageview. `path` falls back to
     * `location.pathname` when omitted (used both for manual trackPageview()
     * calls and for auto-mode navigation). A missing/empty resolved path, or
     * one over the 512-char wire cap, drops the whole pageview (structural
     * violation - mirrors what the server would reject). An over-length
     * referrer instead just omits the referrer field and keeps the pageview:
     * referrer is optional/best-effort, so degrading gracefully beats losing
     * an entire pageview count over an incidental field.
     */
    sendPageview(explicitPath) {
        const path = this.resolvePath(explicitPath);
        if (!path) {
            this.log('debug', 'trackPageview: dropped (no path available)');
            return;
        }
        if (path.length > USAGE_PATH_MAX) {
            this.log('debug', 'trackPageview: dropped (path exceeds 512 chars)');
            return;
        }
        const evt = { type: 'pageview', ts: this.now(), path };
        if (!this.referrerSent) {
            this.referrerSent = true;
            const doc = this.doc;
            const ref = doc && typeof doc.referrer === 'string' ? doc.referrer : '';
            if (ref) {
                if (ref.length > USAGE_REFERRER_MAX) {
                    this.log('debug', 'trackPageview: referrer exceeds 512 chars; omitted');
                }
                else {
                    evt.referrer = ref;
                }
            }
        }
        this.enqueueAnalytics(evt);
    }
    /** Validates trackEvent's `props`; ok:false means "drop the whole event" (reason logged here). */
    validateProps(props) {
        if (props === undefined)
            return { ok: true };
        if (typeof props !== 'object' || props === null) {
            this.log('debug', 'trackEvent: props must be an object; dropped');
            return { ok: false };
        }
        const keys = Object.keys(props);
        if (keys.length > USAGE_PROPS_MAX_KEYS) {
            this.log('debug', `trackEvent: too many props (${String(keys.length)} > 10); dropped`);
            return { ok: false };
        }
        const clean = {};
        for (const key of keys) {
            if (key.length > USAGE_PROP_KEY_MAX) {
                this.log('debug', `trackEvent: prop key ${JSON.stringify(safeStr(key, 80))} too long; dropped`);
                return { ok: false };
            }
            const value = props[key];
            if (typeof value === 'string') {
                if (value.length > USAGE_PROP_VALUE_MAX) {
                    this.log('debug', `trackEvent: prop "${key}" value exceeds 256 chars; dropped`);
                    return { ok: false };
                }
                clean[key] = value;
            }
            else if (typeof value === 'number') {
                if (!Number.isFinite(value)) {
                    this.log('debug', `trackEvent: prop "${key}" is not a finite number; dropped`);
                    return { ok: false };
                }
                clean[key] = value;
            }
            else if (typeof value === 'boolean') {
                clean[key] = value;
            }
            else {
                this.log('debug', `trackEvent: prop "${key}" has an unsupported value type; dropped`);
                return { ok: false };
            }
        }
        return keys.length > 0 ? { ok: true, props: clean } : { ok: true };
    }
    enqueueAnalytics(evt) {
        if (!this.dsn)
            return;
        this.analyticsQueue.push(evt);
        if (this.analyticsQueue.length >= ANALYTICS_MAX_QUEUE) {
            void this.flushAnalytics();
            return;
        }
        this.ensureAnalyticsTimer();
    }
    ensureAnalyticsTimer() {
        if (this.analyticsTimer !== null)
            return;
        this.analyticsTimer = this.setTimeoutFn(() => {
            this.analyticsTimer = null;
            void this.flushAnalytics();
        }, ANALYTICS_DEBOUNCE_MS);
        // Do not keep a Node event loop alive purely for a pending analytics batch.
        try {
            const t = this.analyticsTimer;
            if (t && typeof t.unref === 'function')
                t.unref();
        }
        catch {
            // unref unavailable (browser); harmless
        }
    }
    clearAnalyticsTimer() {
        if (this.analyticsTimer !== null) {
            try {
                this.clearTimeoutFn(this.analyticsTimer);
            }
            catch {
                // ignore
            }
            this.analyticsTimer = null;
        }
    }
    /** Drains the analytics queue with a single POST. Resolves once sent (or immediately if empty). */
    flushAnalytics() {
        this.clearAnalyticsTimer();
        if (!this.dsn || this.analyticsQueue.length === 0)
            return Promise.resolve();
        const batch = this.analyticsQueue;
        this.analyticsQueue = [];
        return this.sendAnalyticsBatch(batch);
    }
    /**
     * Single-attempt POST of `{ events }` to `<ingestUrl>/usage`. Lossy by
     * design: the batch is already removed from the queue by the caller
     * before this runs, so on any failure (network error, non-2xx response)
     * it is simply dropped - no retry, no spool, matching the crash queue's
     * discipline is deliberately NOT done here.
     */
    async sendAnalyticsBatch(events) {
        const dsn = this.dsn;
        const fetchFn = this.fetchFn;
        if (!dsn || !fetchFn)
            return;
        let controller;
        try {
            const Ctor = G.AbortController;
            if (Ctor)
                controller = new Ctor();
        }
        catch {
            controller = undefined;
        }
        const timer = controller
            ? this.setTimeoutFn(() => {
                try {
                    controller?.abort();
                }
                catch {
                    // ignore
                }
            }, SEND_TIMEOUT_MS)
            : null;
        try {
            const init = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events }),
                ...(this.runtime === 'browser' ? { keepalive: true } : {}),
                ...(controller ? { signal: controller.signal } : {}),
            };
            const res = await fetchFn(`${dsn.ingestUrl}/usage`, init);
            if (!res.ok) {
                this.log('debug', `analytics batch dropped on non-2xx response (${String(res.status)})`);
            }
        }
        catch {
            this.log('debug', 'analytics batch dropped: send failed (no retry, no spool)');
        }
        finally {
            if (timer !== null)
                this.clearTimeoutFn(timer);
        }
    }
    /** Beacon-based batch flush for pagehide/hidden, mirroring the crash queue's beaconFlush discipline. */
    beaconFlushAnalytics() {
        if (!this.dsn || this.analyticsQueue.length === 0)
            return;
        this.clearAnalyticsTimer();
        const batch = this.analyticsQueue;
        this.analyticsQueue = [];
        const nav = this.nav;
        const beacon = nav && typeof nav.sendBeacon === 'function' ? nav.sendBeacon.bind(nav) : null;
        if (!beacon) {
            // No beacon support: best-effort async send. The page may unload
            // before this completes - acceptable, analytics is lossy by design.
            void this.sendAnalyticsBatch(batch);
            return;
        }
        try {
            const ok = beacon(`${this.dsn.ingestUrl}/usage`, this.beaconBody({ events: batch }));
            if (!ok)
                this.log('debug', 'analytics beacon flush rejected by the browser; batch dropped');
        }
        catch {
            this.log('debug', 'analytics beacon flush failed; batch dropped');
        }
    }
    /**
     * Browser-only. When `analytics.auto` is set: sends one initial pageview,
     * then hooks History pushState/replaceState + popstate to auto-track SPA
     * navigation, de-duping consecutive identical paths. No-op otherwise.
     */
    installAutoAnalytics() {
        if (!this.opts.analytics?.auto)
            return;
        try {
            this.sendPageview(undefined);
            this.lastAutoPath = this.resolvePath(undefined);
            this.installHistoryHooks();
            this.installPopstateHook();
        }
        catch (e) {
            this.log('debug', 'failed to install auto analytics', e);
        }
    }
    /**
     * Wraps history.pushState/replaceState: always calls the original through
     * (via apply, forwarding `this` and args) and always rethrows exactly what
     * the original threw, if anything - our tracking hook runs regardless and
     * never itself alters that call's outcome. Restored verbatim on close().
     */
    installHistoryHooks() {
        const hist = this.history;
        if (!hist)
            return;
        const handleNavigation = () => this.handleAutoNavigation();
        const wrap = (method) => {
            const original = hist[method];
            if (typeof original !== 'function')
                return;
            const wrapped = function (...args) {
                let threw = false;
                let err;
                let result;
                try {
                    result = original.apply(this, args);
                }
                catch (e) {
                    threw = true;
                    err = e;
                }
                try {
                    handleNavigation();
                }
                catch {
                    // tracking must never affect the original call's outcome
                }
                if (threw)
                    throw err;
                return result;
            };
            hist[method] = wrapped;
            this.uninstallers.push(() => {
                try {
                    if (hist[method] === wrapped)
                        hist[method] = original;
                }
                catch {
                    // best-effort teardown
                }
            });
        };
        wrap('pushState');
        wrap('replaceState');
    }
    installPopstateHook() {
        const target = this.win;
        if (!target || typeof target.addEventListener !== 'function')
            return;
        const onPopState = () => this.handleAutoNavigation();
        target.addEventListener('popstate', onPopState);
        this.uninstallers.push(() => {
            try {
                target.removeEventListener?.('popstate', onPopState);
            }
            catch {
                // best-effort teardown
            }
        });
    }
    /** Sends an auto-mode pageview for the current location, de-duping consecutive identical paths. */
    handleAutoNavigation() {
        try {
            const path = this.resolvePath(undefined);
            if (path === this.lastAutoPath)
                return;
            this.lastAutoPath = path;
            this.sendPageview(path);
        }
        catch (e) {
            this.log('debug', 'auto pageview tracking failed', e);
        }
    }
    /** Pending analytics-queue length (test/introspection helper). */
    analyticsSize() {
        return this.analyticsQueue.length;
    }
    // ---- lifecycle ---------------------------------------------------------
    /** Best-effort drain bounded by `timeoutMs`. Never rejects. */
    async flush(timeoutMs = 5_000) {
        try {
            await this.flushWithTimeout(timeoutMs);
        }
        catch {
            // best-effort
        }
    }
    flushWithTimeout(ms) {
        return new Promise((resolve) => {
            let settled = false;
            // `timer` is declared before `finish` so a setTimeout stub that fires its
            // callback synchronously does not hit a temporal-dead-zone reference.
            let timer = null;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                if (timer !== null)
                    this.clearTimeoutFn(timer);
                resolve();
            };
            timer = this.setTimeoutFn(finish, ms);
            Promise.all([this.drainQueue(), this.flushAnalytics()]).then(finish, finish);
        });
    }
    close() {
        this.closed = true;
        for (const fn of this.uninstallers) {
            try {
                fn();
            }
            catch {
                // best-effort teardown
            }
        }
        this.uninstallers = [];
        this.clearRetryTimer();
        // Best-effort, fire-and-forget final flush of any pending analytics
        // (lossy by design - close() does not await or retry this).
        void this.flushAnalytics();
        // Persist any still-pending events before we go, then stop the debounce.
        this.flushSpool(true);
        this.clearSpoolTimer();
    }
    /** Pending queue length (test/introspection helper). */
    size() {
        return this.queue.length;
    }
}
function pick(dep, fromGlobal) {
    if (dep === null)
        return undefined;
    if (dep === undefined)
        return fromGlobal;
    return dep;
}
// ---------------------------------------------------------------------------
// Functional singleton API - what consumer apps import. Every entry point is
// wrapped so it can never throw out of the public surface.
// ---------------------------------------------------------------------------
let current = null;
export function init(opts) {
    try {
        if (current)
            current.close();
        current = new Client(opts);
        current.install();
    }
    catch (e) {
        current = null;
        try {
            if (opts && opts.debug) {
                const c = G.console;
                if (c && typeof c.error === 'function')
                    c.error('uh-oh: init failed', e);
            }
        }
        catch {
            // never throw
        }
    }
}
export function captureException(err, opts) {
    try {
        return current ? current.captureException(err, opts) : '';
    }
    catch {
        return '';
    }
}
export function captureMessage(msg, level) {
    try {
        return current ? current.captureMessage(msg, level) : '';
    }
    catch {
        return '';
    }
}
export function addBreadcrumb(b) {
    try {
        current?.addBreadcrumb(b);
    }
    catch {
        // never throw
    }
}
export function setUser(u) {
    try {
        current?.setUser(u);
    }
    catch {
        // never throw
    }
}
export function setContext(key, value) {
    try {
        current?.setContext(key, value);
    }
    catch {
        // never throw
    }
}
export function setTag(key, value) {
    try {
        current?.setTag(key, value);
    }
    catch {
        // never throw
    }
}
export function setFingerprint(parts) {
    try {
        current?.setFingerprint(parts);
    }
    catch {
        // never throw
    }
}
export function checkIn(slug, opts) {
    try {
        current?.checkIn(slug, opts);
    }
    catch {
        // never throw
    }
}
export function trackPageview(path) {
    try {
        current?.trackPageview(path);
    }
    catch {
        // never throw
    }
}
export function trackEvent(name, props) {
    try {
        current?.trackEvent(name, props);
    }
    catch {
        // never throw
    }
}
export function flush(timeoutMs) {
    try {
        return current ? current.flush(timeoutMs) : Promise.resolve();
    }
    catch {
        return Promise.resolve();
    }
}
export function close() {
    try {
        current?.close();
    }
    catch {
        // never throw
    }
    finally {
        current = null;
    }
}
//# sourceMappingURL=uh-oh-client.js.map