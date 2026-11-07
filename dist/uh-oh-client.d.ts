export type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export type Level = 'fatal' | 'error' | 'warning' | 'info';
export type BreadcrumbLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal';
export type Mechanism = 'js-global' | 'js-promise' | 'js-manual' | 'android-java-ueh' | 'android-ndk-signal' | 'android-anr';
export interface StackFrame {
    function?: string;
    module?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    inApp: boolean;
}
export interface Breadcrumb {
    category: string;
    message: string;
    level: BreadcrumbLevel;
    ts: string;
    data?: Record<string, JsonValue>;
}
export interface DeviceInfo {
    osName: string;
    osVersion: string;
    deviceModel?: string;
    deviceManufacturer?: string;
    arch?: string;
    locale?: string;
    timezone?: string;
    memoryTotal?: number;
    diskFree?: number;
}
export interface UserInfo {
    id: string;
    email?: string;
    username?: string;
}
export interface ExceptionInfo {
    type: string;
    value: string;
    stacktrace: StackFrame[];
    mechanism: Mechanism;
}
export interface EventEnvelope {
    sdk: {
        name: string;
        version: string;
    };
    timestamp: string;
    platform: 'ios' | 'android' | 'web' | 'node';
    release: {
        version: string;
        build: string;
    };
    level: Level;
    exception: ExceptionInfo;
    breadcrumbs: Breadcrumb[];
    user?: UserInfo;
    context?: Record<string, JsonValue>;
    tags?: Record<string, string>;
    device: DeviceInfo;
    fingerprint?: string[];
}
export interface AnalyticsOptions {
    /**
     * Browser runtime only; ignored on node (trackEvent still works there,
     * trackPageview does not - pageviews are a browser concept). Default off.
     * When true: sends an initial pageview on install, then tracks SPA
     * navigation via wrapped History pushState/replaceState + popstate.
     */
    auto?: boolean;
}
export interface InitOptions {
    /** http(s)://<publicKey>@<host>[:port][/path]. Absent/empty = silent no-op. */
    dsn?: string;
    /** "version+build", e.g. "1.4.2+37". Missing "+build" defaults build to "0". */
    release: string;
    environment?: string;
    beforeSend?: (e: EventEnvelope) => EventEnvelope | null;
    debug?: boolean;
    /** Default 100; emitted breadcrumbs are additionally capped at the wire max of 100. */
    maxBreadcrumbs?: number;
    /** Override auto-detection (window+document => browser, else node). */
    runtime?: 'browser' | 'node';
    /** Usage analytics (trackPageview/trackEvent); see AnalyticsOptions. */
    analytics?: AnalyticsOptions;
    /**
     * Node runtime only (ignored on browser): directory in which to persist the
     * pending queue as `<spoolDir>/uh-oh-spool.json`, so events captured while
     * offline survive a process restart. Writes are atomic (tmp + rename) and
     * debounced (~1s); any filesystem failure is swallowed (never throws). No
     * effect when the host has no reachable `node:fs`.
     */
    spoolDir?: string;
    /**
     * Opt-in (default false/absent = off; browser AND Node): wraps
     * console.debug/log/info/warn/error so every call still invokes the
     * original with unchanged arguments and `this`, and additionally records a
     * `{ category: 'console' }` breadcrumb (level per method: debug->debug,
     * log/info->info, warn->warning, error->error). A re-entrancy guard drops
     * any console call made while a breadcrumb is being recorded (including one
     * triggered by a toJSON during stringification, and uh-oh's own debug
     * logging) - it still reaches the original, it is just not recorded, and
     * never recurses. Fully restored on close().
     */
    consoleBreadcrumbs?: boolean;
}
export interface CaptureOptions {
    level?: Level;
    mechanism?: Mechanism;
}
export interface CheckInOptions {
    /**
     * Minutes between expected check-ins. Required by the server on a
     * monitor's first-ever ping (it 400s without it); optional on later pings
     * (omit to leave the monitor's configured interval unchanged).
     */
    intervalMinutes?: number;
}
export interface BreadcrumbInput {
    category: string;
    message: string;
    level?: BreadcrumbLevel;
    data?: Record<string, unknown>;
}
/**
 * Wire shape for one usage-analytics event, mirroring CONTRACT U-IN's
 * `POST /ingest/:publicKey/usage` body element. Deliberately lean (no sdk/
 * device/release metadata like EventEnvelope) - it carries no identifier of
 * any kind; the server derives identity from the request itself.
 */
export interface UsageEvent {
    type: 'pageview' | 'event';
    /** Epoch ms; informational only - the server's receivedAt is authoritative. */
    ts: number;
    /** Required for 'pageview'. <=512 chars. */
    path?: string;
    /** Only ever set on the first pageview after init; raw (server reduces to domain). */
    referrer?: string;
    /** Required for 'event'. /^[a-zA-Z0-9_-]{1,64}$/ */
    name?: string;
    /** <=10 keys, keys <=64 chars, string values <=256 chars. */
    props?: Record<string, string | number | boolean>;
    /**
     * Stamped automatically from `init`'s release on every event (usage
     * release attribution) - not settable via trackPageview/trackEvent.
     * <=128 chars.
     */
    release?: string;
}
interface FetchInit {
    method: string;
    headers: Record<string, string>;
    body: string;
    keepalive?: boolean;
    signal?: unknown;
}
interface FetchResponse {
    ok: boolean;
    status: number;
}
type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
interface StorageLike {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}
/**
 * Minimal synchronous `node:fs` surface used by the optional Node disk spool.
 * Self-declared (not the ambient Node types) so the file still compiles with
 * `types: []`. `existsSync`/`unlinkSync` are optional: the spool tolerates a
 * fake that omits them.
 */
export interface FsLike {
    mkdirSync: (path: string, opts?: {
        recursive?: boolean;
    }) => unknown;
    writeFileSync: (path: string, data: string) => void;
    renameSync: (from: string, to: string) => void;
    readFileSync: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
    unlinkSync?: (path: string) => void;
}
interface NavigatorLike {
    userAgent?: string;
    language?: string;
    sendBeacon?: (url: string, data?: unknown) => boolean;
}
interface DocumentLike {
    visibilityState?: string;
    referrer?: string;
}
interface LocationLike {
    pathname?: string;
}
interface HistoryLike {
    pushState: (...args: unknown[]) => unknown;
    replaceState: (...args: unknown[]) => unknown;
}
interface CryptoLike {
    randomUUID?: () => string;
}
interface EventTargetLike {
    addEventListener?: (type: string, listener: (ev: unknown) => void, opts?: unknown) => void;
    removeEventListener?: (type: string, listener: (ev: unknown) => void, opts?: unknown) => void;
}
interface ProcessLike {
    platform?: string;
    version?: string;
    arch?: string;
    on?: (event: string, listener: (arg: unknown) => void) => void;
    off?: (event: string, listener: (arg: unknown) => void) => void;
    removeListener?: (event: string, listener: (arg: unknown) => void) => void;
    listeners?: (event: string) => unknown[];
    exit?: (code?: number) => void;
    stderr?: {
        write?: (s: string) => void;
    };
}
interface ConsoleLike {
    debug?: (...args: unknown[]) => unknown;
    log?: (...args: unknown[]) => unknown;
    info?: (...args: unknown[]) => unknown;
    warn?: (...args: unknown[]) => unknown;
    error?: (...args: unknown[]) => unknown;
}
type TimerSet = (cb: () => void, ms: number) => unknown;
type TimerClear = (handle: unknown) => void;
/** Test/advanced seam: inject fakes to exercise both runtimes without jsdom. */
export interface ClientDeps {
    fetchFn?: FetchLike | null;
    proc?: ProcessLike | null;
    win?: EventTargetLike | null;
    doc?: DocumentLike | null;
    navigator?: NavigatorLike | null;
    storage?: StorageLike | null;
    /** Test/advanced seam for auto-mode pageviews (defaults to location.pathname). */
    location?: LocationLike | null;
    /** Test/advanced seam for auto-mode SPA-navigation hooks (pushState/replaceState). */
    history?: HistoryLike | null;
    cryptoObj?: CryptoLike | null;
    /** Inject a fake `node:fs` for the Node disk-spool tests. */
    fs?: FsLike | null;
    /** Test/advanced seam to inject a fake console for the console-breadcrumbs tests. */
    consoleObj?: ConsoleLike | null;
    now?: () => number;
    setTimeoutFn?: TimerSet;
    clearTimeoutFn?: TimerClear;
    setIntervalFn?: TimerSet;
    clearIntervalFn?: TimerClear;
}
export interface ParsedDsn {
    publicKey: string;
    /** origin + optional path prefix, no trailing slash. */
    baseUrl: string;
    /** Full ingest endpoint: `${baseUrl}/ingest/${publicKey}`. */
    ingestUrl: string;
}
/**
 * Parses `http(s)://<publicKey>@<host>[:port][/path]`. Returns null (never
 * throws) for absent, empty, or malformed input so the caller can no-op.
 */
export declare function parseDsn(dsn: string | undefined): ParsedDsn | null;
export declare class Client {
    private readonly opts;
    private readonly runtime;
    private readonly maxBreadcrumbs;
    /** Raw init release, capped, stamped onto every usage event (usage release attribution). */
    private readonly usageRelease;
    private readonly fetchFn;
    private readonly proc;
    private readonly win;
    private readonly doc;
    private readonly nav;
    private readonly storage;
    private readonly cryptoObj;
    private readonly location;
    private readonly history;
    private readonly consoleObj;
    private readonly now;
    private readonly setTimeoutFn;
    private readonly clearTimeoutFn;
    private readonly setIntervalFn;
    private readonly clearIntervalFn;
    private dsn;
    private readonly noop;
    private closed;
    private user;
    private tags;
    private ctx;
    private fingerprint;
    private breadcrumbs;
    private queue;
    private inFlight;
    private capturing;
    private drainInFlight;
    private drainRequested;
    private retryTimer;
    private uninstallers;
    private wasOnlyUncaughtListener;
    private consoleOriginals;
    private consoleRecording;
    private analyticsQueue;
    private analyticsTimer;
    private referrerSent;
    private lastAutoPath;
    private readonly fs;
    private readonly spoolDir;
    private readonly spoolFile;
    private readonly spoolTmp;
    private spoolTimer;
    private spoolDirty;
    constructor(opts: InitOptions, deps?: ClientDeps);
    private log;
    install(): void;
    private installBrowserHandlers;
    private installLifecycleFlush;
    private installNodeHandlers;
    private onUncaughtException;
    private writeStderr;
    /**
     * Wraps console.debug/log/info/warn/error (whichever exist as functions).
     * Guarded against double-init (consoleOriginals already set => no-op, so a
     * second install() on the same instance never nests wrappers). Each wrapped
     * method always calls the original with unchanged arguments and `this` -
     * mirroring installHistoryHooks's call-through-then-rethrow shape - and
     * records regardless of whether the original threw.
     */
    private installConsoleBreadcrumbs;
    /** Restores the exact original console functions. Idempotent. */
    private restoreConsole;
    /**
     * Records one console breadcrumb. Re-entrancy guard: a console call made
     * WHILE this runs (a toJSON invoked by stringifyConsoleArgs's JSON.stringify,
     * or a nested this.log() debug call from the catch block below) sees
     * consoleRecording already true and returns immediately - the original still
     * ran (the wrapper calls it unconditionally before reaching here), it is
     * simply not recorded, and there is no recursion.
     */
    private recordConsoleBreadcrumb;
    /** Primitives via String, objects via JSON.stringify (fallback below), space-joined, 500-char cap. */
    private stringifyConsoleArgs;
    private stringifyConsoleArg;
    captureException(err: unknown, opts?: CaptureOptions): string;
    captureMessage(msg: string, level?: Level): string;
    private captureWithException;
    private applyBeforeSend;
    private buildEnvelope;
    private buildDevice;
    private resolveTimezone;
    addBreadcrumb(b: BreadcrumbInput): void;
    setUser(u: UserInfo | null): void;
    setContext(key: string, value: Record<string, unknown> | null): void;
    setTag(key: string, value: string | null): void;
    setFingerprint(parts: string[] | null): void;
    /**
     * Fire-and-forget check-in ping for a named monitor. One attempt only -
     * never queued, spooled, or retried, since a late check-in is worthless.
     * Silent no-op when uninitialised/no dsn; an invalid slug is dropped (debug
     * log only). Never throws. No re-entrancy guard needed: unlike capture,
     * this has no pipeline for a failure to loop back through.
     */
    checkIn(slug: string, opts?: CheckInOptions): void;
    /**
     * Single-attempt POST for a check-in ping (post() may repeat a refused
     * keepalive send once without keepalive). Swallows every failure (network
     * error, timeout, non-2xx) - there is no queue or retry timer for check-ins.
     */
    private sendCheckIn;
    private enqueue;
    /**
     * sendOne for a queue item, recorded in `inFlight` until it settles so that
     * beaconFlush leaves it alone. For an item beaconFlush handed to its
     * keepalive request (and so left out of the spool):
     * - a TypeError is treated like a sent beacon and the item is dropped.
     *   Chromium rejects an in-flight keepalive fetch with "TypeError: Failed to
     *   fetch" as the page unloads while the request itself goes on to the
     *   server (Chromium 149: the rejection came 1 ms after pagehide and the
     *   POST still arrived). Retrying or re-spooling it would send it twice.
     * - any other outcome (an HTTP answer, or our own timeout's abort, which
     *   does cancel the request) goes back into the spool and drainOnce handles
     *   it as usual: a 202 removes it, a 503 keeps it for a retry.
     */
    private sendQueued;
    private sendOne;
    /**
     * One POST, with keepalive in the browser whenever the browser will take it,
     * so the send can outlive the page. Chrome refuses a keepalive request past
     * the 64 KiB quota with "TypeError: Failed to fetch" before anything is
     * sent; drainOnce read that as a network error, so an envelope over 64 KiB
     * (100 breadcrumbs of 1 KB) failed on every retry and held up every crash
     * queued behind it. So a body over KEEPALIVE_BODY_MAX goes without
     * keepalive, and a keepalive send that rejects with a TypeError (the quota
     * is shared with other keepalive requests in flight) is retried once
     * without it. Offline that costs one extra failed attempt. An abort is not
     * a TypeError and is not retried. Rejects when the last attempt rejects.
     * `flight` (a queued crash's send) records which kind of request is going.
     */
    private post;
    /**
     * Starts a host timer and never throws. A host timer that throws (an unbound
     * browser setTimeout raises "Illegal invocation") yields null and the caller
     * degrades: no abort timeout, no retry tick, no debounce. It must not reject
     * instead, because a rejection out of this pipeline reaches the client's own
     * unhandledrejection handler, which captures it, fails to send it, and
     * captures that failure again: an endless loop. `unref` keeps a Node event
     * loop from being held open by uh-oh alone.
     */
    private startTimer;
    /** Clears a timer from startTimer and never throws. */
    private stopTimer;
    /**
     * Coalescing drain: at most one runs; a request mid-drain triggers one more.
     * The returned promise never rejects (callers fire it with `void`).
     */
    private drainQueue;
    /**
     * Lets go of the drain in the same step as its last look at the queue, so a
     * capture after that starts a drain of its own. 0.6.1 let go in a .finally
     * on the drain's promise, a few microtasks later: a capture in between only
     * set drainRequested, which nothing read again, and with the queue empty no
     * retry timer ran either, so the event waited for another capture or a page
     * hide (and a flush() in between returned without it).
     */
    private drainLoop;
    /**
     * Sends the queue head by head. While a send is in flight the queue can
     * change under it (beaconFlush rebuilds it, a capture appends, the 50-event
     * cap evicts the oldest), so the head that was sent is removed by id, never
     * by position: shift() used to drop whichever crash had become the head,
     * unsent.
     */
    private drainOnce;
    /** Removes a sent (or permanently refused) item, wherever it now sits. */
    private removeQueued;
    private updateRetryTimer;
    private ensureRetryTimer;
    private clearRetryTimer;
    private persist;
    private persistBrowser;
    private restore;
    private restoreBrowser;
    private safeRemoveSpool;
    /** Validates raw spool entries; drops (with a debug log) any malformed one. */
    private coerceEntries;
    /** Debounced (~1s) request to write the queue to disk. No-op without spool. */
    private scheduleSpool;
    /**
     * Writes the queue to `<spoolDir>/uh-oh-spool.json` atomically: serialize to
     * a sibling `.tmp` file then rename over the target, so a concurrent reader
     * never sees a partially written file. Force-flushes bypass the dirty check
     * (used on close and on the uncaught-exception exit path). Never throws.
     */
    private flushSpool;
    private restoreNode;
    private safeUnlink;
    private clearSpoolTimer;
    private beaconFlush;
    /**
     * Beacon bodies are text/plain on purpose. navigator.sendBeacon always sends
     * with credentials mode "include"; a body typed application/json is not a
     * CORS-safelisted type, so the browser preflights it, and a preflight
     * answered "Access-Control-Allow-Origin: *" fails for a credentialed request,
     * so the POST is never sent (production showed only lone OPTIONS requests).
     * text/plain is a CORS "simple" request: no preflight. Both ingest routes
     * parse a text/plain body as JSON. A bare string body (no Blob) is sent by
     * the browser as text/plain too. `json` is the already serialized payload,
     * so callers can check its size first (fitsKeepalive).
     */
    private beaconBody;
    /**
     * Records a pageview. Browser: defaults `path` to `location.pathname`.
     * Node: always dropped (with a debug log) - pageviews are a browser
     * concept. Silent no-op when uninitialised/no dsn/closed. Never throws.
     */
    trackPageview(path?: string): void;
    /**
     * Records a named custom event with optional props. Works on both
     * runtimes. Validates client-side against the same shape the server
     * enforces (name regex, <=10 props, key/value length caps); any violation
     * drops the WHOLE call (not a partial/truncated send) with a debug log, so
     * the client never ships something the server would reject anyway. Never
     * throws.
     */
    trackEvent(name: string, props?: Record<string, string | number | boolean>): void;
    private resolvePath;
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
    private sendPageview;
    /** Validates trackEvent's `props`; ok:false means "drop the whole event" (reason logged here). */
    private validateProps;
    private enqueueAnalytics;
    private ensureAnalyticsTimer;
    private clearAnalyticsTimer;
    /** Drains the analytics queue with a single POST. Resolves once sent (or immediately if empty). */
    private flushAnalytics;
    /**
     * Single-attempt POST of `{ events }` to `<ingestUrl>/usage`. Lossy by
     * design: the batch is already removed from the queue by the caller
     * before this runs, so on any failure (network error, non-2xx response)
     * it is simply dropped - no retry, no spool, matching the crash queue's
     * discipline is deliberately NOT done here.
     */
    private sendAnalyticsBatch;
    /** Beacon-based batch flush for pagehide/hidden, mirroring the crash queue's beaconFlush discipline. */
    private beaconFlushAnalytics;
    /**
     * Browser-only. When `analytics.auto` is set: sends one initial pageview,
     * then hooks History pushState/replaceState + popstate to auto-track SPA
     * navigation, de-duping consecutive identical paths. No-op otherwise.
     */
    private installAutoAnalytics;
    /**
     * Wraps history.pushState/replaceState: always calls the original through
     * (via apply, forwarding `this` and args) and always rethrows exactly what
     * the original threw, if anything - our tracking hook runs regardless and
     * never itself alters that call's outcome. Restored verbatim on close().
     */
    private installHistoryHooks;
    private installPopstateHook;
    /** Sends an auto-mode pageview for the current location, de-duping consecutive identical paths. */
    private handleAutoNavigation;
    /** Pending analytics-queue length (test/introspection helper). */
    analyticsSize(): number;
    /** Best-effort drain bounded by `timeoutMs`. Never rejects. */
    flush(timeoutMs?: number): Promise<void>;
    private flushWithTimeout;
    close(): void;
    /** Pending queue length (test/introspection helper). */
    size(): number;
}
export declare function init(opts: InitOptions): void;
export declare function captureException(err: unknown, opts?: CaptureOptions): string;
export declare function captureMessage(msg: string, level?: Level): string;
export declare function addBreadcrumb(b: BreadcrumbInput): void;
export declare function setUser(u: UserInfo | null): void;
export declare function setContext(key: string, value: Record<string, unknown> | null): void;
export declare function setTag(key: string, value: string | null): void;
export declare function setFingerprint(parts: string[] | null): void;
export declare function checkIn(slug: string, opts?: CheckInOptions): void;
export declare function trackPageview(path?: string): void;
export declare function trackEvent(name: string, props?: Record<string, string | number | boolean>): void;
export declare function flush(timeoutMs?: number): Promise<void>;
export declare function close(): void;
export {};
//# sourceMappingURL=uh-oh-client.d.ts.map