// TEMPORARY GUARD: drop the reports that @uh-oh/js browser clients older than
// 0.6.1 make about their own timer bug. Remove it once every app is re-vendored
// (see "Removal" at the bottom of this comment).
//
// The bug (SPEC.md section 25). Every copy of the client up to 0.6.0 stored the
// window timers unbound and called them as `this.setTimeoutFn(...)` and
// `this.setIntervalFn(...)`, which every browser rejects with a TypeError. The
// first send threw, `ensureRetryTimer` then threw out of the async drain, the
// client's own `unhandledrejection` handler captured that rejection, and the
// capture started another drain that threw again: over 1,000 reports in the
// first second of a recorded page view, with the 50-slot queue and its
// localStorage spool full of them. The pagehide flush beacons that queue as
// application/json. The old server failed that beacon's credentialed
// preflight, so nothing arrived; the server that echoes the Origin lets them
// through, so every page view of an app still on an old copy (kanban,
// spoonworks, opening-bell and whitespace vendor 0.5.0, bookforge 0.2.0) would
// deliver up to 50 of them (in the recordings all 50 were this report; the
// page's real crash had already been pushed out by the cap), and each project
// would get a new issue and a Discord alert. Firefox and Safari loop the same
// way (recorded below); only the wording and the frames differ.
//
// An envelope is dropped only when ALL of these hold; anything else is stored
// as usual, including a genuine TypeError (or a genuine "Illegal invocation")
// from an old client:
//   - `sdk.name` is "@uh-oh/js" and `sdk.version` sorts before 0.6.1 in semver
//     order. A missing or unparseable version counts as old: from 0.6.1 on the
//     version is test-enforced, so a fixed copy always stamps a real one.
//   - `exception.type` is "TypeError" and `exception.value` is one engine's
//     wording for a window timer called on the wrong `this` (TIMER_BUG_WORDINGS).
//   - The TOP frame (the client lists frames innermost first) is the one that
//     engine's stack leaves there: a client method that calls those stored
//     timers (CLIENT_TIMER_METHODS) in Chromium and Safari, the client method
//     that called one of those (CLIENT_TIMER_CALLERS) in Firefox. Why they
//     differ: every old client drops the first line of `error.stack` as if it
//     were V8's "TypeError: <message>" header.
//       Chromium (V8) has that header, so the throw site stays on top.
//       Safari (JavaScriptCore) has no header, but its stack starts with the
//       native timer's own frame (`setInterval@[native code]`); dropping that
//       leaves the throw site on top here too.
//       Firefox (SpiderMonkey) has neither, so the client drops the throw site
//       itself and the top frame is its caller.
//   The method is read from `function` through each engine's decorations (see
//   methodName): V8 gives `<Class>.<method>`, JavaScriptCore and SpiderMonkey a
//   bare `<method>`; the class is `Client` unminified and a one-letter name in
//   a minified bundle, and the method name survives minifying in all three.
//   Recorded with 0.2.0 (bookforge), 0.5.0 (js-dist) and 0.6.0 (90d24af), plain
//   and minified (0.2.0 has no checkIn() or usage flush), the top frame was:
//                      retry loop         checkIn()     usage flush (20 events)
//     Chromium 149     ensureRetryTimer   sendCheckIn   sendAnalyticsBatch
//     WebKit 26.5      ensureRetryTimer   sendCheckIn   sendAnalyticsBatch
//     Firefox 151      updateRetryTimer   checkIn       flushAnalytics
//   The retry loop was every one of the 50 pagehide beacons in all three.
// The mechanism is not checked: these arrive as "js-promise", which a genuine
// unhandled rejection in the app also carries, so it identifies nothing.
//
// A dropped envelope gets the stored-event answer (202, `{ eventId }` with a
// fresh id that names no row), so the old client takes it off its queue as
// sent. Nothing is written, no issue is opened, no alert fires. Each drop counts
// in `uh_oh_old_client_reports_dropped_total{project="<slug>"}` on /metrics,
// and an info line per project (the first drop, then at most one per
// OLD_CLIENT_DROP_LOG_INTERVAL_MS) carries the running count since the server
// started. Neither names the public key.
//
// Removal: delete this file, its call in ingest.ts, the 'dropped' result and
// route branch, the metric in metrics/registry.ts and old-client-guard.test.ts
// once BOTH hold: every vendoring app runs 0.6.1 or later in production, and
// the counter and log line have shown no drop for about two weeks. The second
// condition matters because a browser that has not revisited still holds the
// old client's spool, and the 0.6.1 client restores the same `uh-oh:spool` key
// and sends those envelopes, still stamped with the old sdk.version, on the
// next visit. Removing the guard early only costs junk issues, never data.

import type { EventEnvelope } from '@uh-oh/types';

import type { ProjectRow } from '../db/schema.js';
import { metrics } from '../metrics/registry.js';

export const JS_SDK_NAME = '@uh-oh/js';

/** The first client version with bound timers (packages/js SDK_VERSION). */
export const FIRST_FIXED_JS_VERSION = '0.6.1';
const FIRST_FIXED: readonly [number, number, number] = [0, 6, 1];

/**
 * Every method of the 0.2.0 to 0.6.0 clients that calls one of the stored,
 * unbound timer functions (`setTimeoutFn`, `setIntervalFn`, `clearTimeoutFn`,
 * `clearIntervalFn`), so every place the bug can throw from. Only the first
 * three ever reached the client's own capture in the recordings; the rest are
 * listed so the set is exactly "the client's timer call sites", not a guess.
 * The top frame in Chromium and Safari.
 */
export const CLIENT_TIMER_METHODS: ReadonlySet<string> = new Set([
  'ensureRetryTimer',
  'sendCheckIn',
  'sendAnalyticsBatch',
  'sendOne',
  'clearRetryTimer',
  'scheduleSpool',
  'clearSpoolTimer',
  'ensureAnalyticsTimer',
  'clearAnalyticsTimer',
  'flushWithTimeout',
]);

/**
 * Every method of the 0.2.0 to 0.6.0 clients that calls one of
 * CLIENT_TIMER_METHODS (read off the three sources' syntax trees), so every
 * frame Firefox can leave on top once the client has dropped the throw site.
 * `flushWithTimeout` is here too: its timer calls sit in arrow functions inside
 * it, so it is the frame below them. Only the first three ever reached the
 * client's own capture in the recordings. Some are names an app might also use
 * (`checkIn`, `flush`, `close`); with the Firefox wording and an old sdk
 * version also required, an app's own report would need its own unbound window
 * timer called from a function of that name to be dropped.
 */
export const CLIENT_TIMER_CALLERS: ReadonlySet<string> = new Set([
  'updateRetryTimer',
  'checkIn',
  'flushAnalytics',
  'drainOnce',
  'persist',
  'enqueueAnalytics',
  'beaconFlushAnalytics',
  'flush',
  'onUncaughtException',
  'close',
  'flushWithTimeout',
]);

const TIMER = '(?:setTimeout|setInterval|clearTimeout|clearInterval)';

/** One engine's message for this error, and the frames its stack leaves on top. */
export type TimerBugWording = {
  engine: 'chromium' | 'firefox' | 'webkit';
  message: RegExp;
  topFrames: ReadonlySet<string>;
};

/**
 * How each engine words a window timer called with the wrong `this`, probed
 * for all four timers in Playwright's Chromium 149, Firefox 151 and WebKit 26.5
 * (the recordings carried setTimeout and setInterval; the client only clears a
 * timer that was set, so its clear calls never ran):
 *   Chromium  Illegal invocation
 *   Firefox   'setInterval' called on an object that does not implement interface Window.
 *   WebKit    Can only call Window.setInterval on instances of Window
 * Chromium's is matched anywhere in the message, as before; the other two name
 * the timer and are matched whole.
 */
export const TIMER_BUG_WORDINGS: readonly TimerBugWording[] = [
  { engine: 'chromium', message: /Illegal invocation/, topFrames: CLIENT_TIMER_METHODS },
  {
    engine: 'firefox',
    message: new RegExp(
      `^'${TIMER}' called on an object that does not implement interface Window\\.$`,
    ),
    topFrames: CLIENT_TIMER_CALLERS,
  },
  {
    engine: 'webkit',
    message: new RegExp(`^Can only call Window\\.${TIMER} on instances of Window$`),
    topFrames: CLIENT_TIMER_METHODS,
  },
];

// major[.minor[.patch]][-prerelease][+build], with an optional leading "v".
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * True when `version` sorts before 0.6.1 in semver order (numeric parts, so
 * 0.10.0 is newer, and a 0.6.1 pre-release is older). A missing, empty or
 * unparseable version counts as old.
 */
export const isBeforeFixedJsClient = (version: string | undefined): boolean => {
  const m = typeof version === 'string' ? VERSION_RE.exec(version.trim()) : null;
  if (!m) return true;
  const parts = [Number(m[1]), Number(m[2] ?? '0'), Number(m[3] ?? '0')] as const;
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const fixed = FIRST_FIXED[i] ?? 0;
    if (have !== fixed) return have < fixed;
  }
  return m[4] !== undefined;
};

/**
 * The method name of a frame's `function` as the client records it from a
 * stack line. V8: `Client.ensureRetryTimer`, `b.ensureRetryTimer`,
 * `async Client.sendOne` or `Client.sendOne [as send]` all give the part after
 * the last dot. JavaScriptCore and SpiderMonkey: a bare `ensureRetryTimer`
 * gives itself, and SpiderMonkey's async-cause prefix on the first frame of an
 * async segment (`async*drainQueue`,
 * `EventListener.handleEvent*installBrowserHandlers`) is dropped first.
 */
const methodName = (fn: string): string => {
  let name = fn.trim();
  name = name.slice(name.lastIndexOf('*') + 1);
  if (name.startsWith('async ')) name = name.slice('async '.length).trimStart();
  const alias = / \[as [^\]]*\]$/.exec(name);
  if (alias) name = name.slice(0, alias.index);
  return name.slice(name.lastIndexOf('.') + 1);
};

/** True when the envelope is an old browser client's report of its own timer bug. */
export const isOldClientSelfReport = (envelope: EventEnvelope): boolean => {
  const sdk = envelope.sdk as Partial<EventEnvelope['sdk']> | undefined;
  if (sdk?.name !== JS_SDK_NAME || !isBeforeFixedJsClient(sdk.version)) return false;
  const { type, value, stacktrace } = envelope.exception;
  if (type !== 'TypeError') return false;
  const wording = TIMER_BUG_WORDINGS.find((w) => w.message.test(value));
  if (!wording) return false;
  const top = stacktrace[0]?.function;
  return top !== undefined && wording.topFrames.has(methodName(top));
};

/** Logger for the drop line; `toStructuredLogger(app.log)` satisfies it. */
export type OldClientDropLogger = {
  info?: (msg: string, meta?: object) => void;
};

/** At most one drop line per project per this long (the first drop always logs). */
export const OLD_CLIENT_DROP_LOG_INTERVAL_MS = 10 * 60_000;

type DropTally = { dropped: number; logged: number; loggedAt: number | null };

// Per project id, since the process started (like the /metrics counter).
const tallies = new Map<string, DropTally>();

/**
 * Count one dropped report for `project`: the per-project counter always, the
 * info line when this project has not logged one in the last interval.
 */
export const recordOldClientDrop = (
  project: Pick<ProjectRow, 'id' | 'name' | 'slug'>,
  sdkVersion: string | undefined,
  now: number,
  logger: OldClientDropLogger | undefined,
): void => {
  metrics.oldClientReportsDropped.inc({ project: project.slug });
  const tally = tallies.get(project.id) ?? { dropped: 0, logged: 0, loggedAt: null };
  tally.dropped += 1;
  tallies.set(project.id, tally);
  if (tally.loggedAt !== null && now - tally.loggedAt < OLD_CLIENT_DROP_LOG_INTERVAL_MS) return;
  logger?.info?.(
    `dropped an @uh-oh/js client's own unbound-timer TypeError report (client before ${FIRST_FIXED_JS_VERSION}; re-vendor the app)`,
    {
      projectId: project.id,
      project: project.name,
      slug: project.slug,
      sdkVersion: sdkVersion ?? null,
      dropped: tally.dropped,
      droppedSinceLastLine: tally.dropped - tally.logged,
    },
  );
  tally.logged = tally.dropped;
  tally.loggedAt = now;
};
