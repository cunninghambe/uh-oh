// The temporary guard against old @uh-oh/js clients' reports of their own
// unbound-timer bug (old-client-guard.ts). The fixtures are what the clients
// really send: the 0.2.0 (bookforge), 0.5.0 (js-dist, vendored in kanban,
// spoonworks, opening-bell and whitespace) and 0.6.0 (90d24af) sources, plain
// and minified with esbuild, recorded in Chromium 149 on a harness page at
// http://localhost:34611 posting to a stub ingest that answered the credentialed
// preflight. The same harness recorded Firefox 151 and WebKit 26.5 (Playwright
// 1.61.1) running the js-dist 0.5.0 file as shipped and the 0.2.0 and 0.6.0
// sources with their types stripped, each plain and minified into an app
// bundle (0.2.0 has no checkIn() or usage flush, so only its retry loop); the
// page's own code (app.js) started each scenario. The BEACON_* strings are pagehide
// beacon bodies byte for byte, and the APP_*_FIREFOX/WEBKIT strings the queued
// envelope byte for byte; the other check-in, usage and retry-loop frames are
// the recorded ones down to the client's public function (the harness's frames
// below that are left out).
import type { EventEnvelope, StackFrame } from '@uh-oh/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { listIssues } from '../db/repos/issues.js';
import { listReleasesForProject } from '../db/repos/releases.js';
import { takeDueDispatches } from '../db/repos/webhook-dispatches.js';
import { events } from '../db/schema.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';
import { metrics } from '../metrics/registry.js';
import { captureLog, forwardLevel } from '../logging/test-utils.js';

import { ingest as ingestFn } from './ingest.js';
import {
  CLIENT_TIMER_CALLERS,
  CLIENT_TIMER_METHODS,
  isBeforeFixedJsClient,
  isOldClientSelfReport,
  OLD_CLIENT_DROP_LOG_INTERVAL_MS,
  TIMER_BUG_WORDINGS,
} from './old-client-guard.js';
import { createRateLimiter } from './rate-limit.js';

// ---------------------------------------------------------------------------
// Recorded fixtures.
// ---------------------------------------------------------------------------

/** 0.5.0 (the js-dist build), unminified: the retry-loop report, as beaconed. */
const BEACON_050 =
  '{"sdk":{"name":"@uh-oh/js","version":"0.5.0"},"timestamp":"2026-10-04T03:14:54.921Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Illegal invocation","stacktrace":[{"inApp":true,"function":"Client.ensureRetryTimer","filename":"http://localhost:34611/build/client-050.js","lineno":745,"colno":28},{"inApp":true,"function":"Client.updateRetryTimer","filename":"http://localhost:34611/build/client-050.js","lineno":737,"colno":12},{"inApp":true,"function":"Client.drainLoop","filename":"http://localhost:34611/build/client-050.js","lineno":689,"colno":10}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"e8c3e81a-8070-4752-9ff3-448594fea6fe"}}';

/** 0.6.0 (90d24af), minified into an app bundle: the class is `b`. */
const BEACON_060_MIN =
  '{"sdk":{"name":"@uh-oh/js","version":"0.6.0"},"timestamp":"2026-10-04T03:15:02.952Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Illegal invocation","stacktrace":[{"inApp":true,"function":"b.ensureRetryTimer","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":6847},{"inApp":true,"function":"b.updateRetryTimer","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":6738},{"inApp":true,"function":"b.drainLoop","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":5980}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"e9b50635-d686-4128-be30-ba4c75a0b871"}}';

/** 0.2.0 (bookforge's vendored copy), minified: the class is `g`. */
const BEACON_020_MIN =
  '{"sdk":{"name":"@uh-oh/js","version":"0.2.0"},"timestamp":"2026-10-04T03:14:52.232Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Illegal invocation","stacktrace":[{"inApp":true,"function":"g.ensureRetryTimer","filename":"http://localhost:34611/build/bundle-020.min.js","lineno":3,"colno":4678},{"inApp":true,"function":"g.updateRetryTimer","filename":"http://localhost:34611/build/bundle-020.min.js","lineno":3,"colno":4569},{"inApp":true,"function":"g.drainLoop","filename":"http://localhost:34611/build/bundle-020.min.js","lineno":3,"colno":3811}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"efe7c35b-aa3e-4f89-9e87-15bc282db520"}}';

/**
 * Firefox 151, 0.5.0 unminified: the retry-loop report, as beaconed. Firefox's
 * stack has no header line, so the client's `slice(1)` dropped the throw site
 * (`ensureRetryTimer@...:882:32`) and its caller is on top. `async*` marks the
 * start of an async segment; the last frame is the stack's trailing newline.
 */
const BEACON_050_FIREFOX =
  '{"sdk":{"name":"@uh-oh/js","version":"0.5.0"},"timestamp":"2026-10-04T03:40:49.778Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"\'setInterval\' called on an object that does not implement interface Window.","stacktrace":[{"inApp":true,"function":"updateRetryTimer","filename":"http://localhost:34611/build/client-050.js","lineno":873,"colno":18},{"inApp":true,"function":"drainLoop","filename":"http://localhost:34611/build/client-050.js","lineno":821,"colno":14},{"inApp":true,"function":"async*drainQueue","filename":"http://localhost:34611/build/client-050.js","lineno":805,"colno":35},{"inApp":true,"function":"captureWithException","filename":"http://localhost:34611/build/client-050.js","lineno":548,"colno":23},{"inApp":true,"function":"onRejection","filename":"http://localhost:34611/build/client-050.js","lineno":379,"colno":22},{"inApp":true,"function":"EventListener.handleEvent*installBrowserHandlers","filename":"http://localhost:34611/build/client-050.js","lineno":382,"colno":20},{"inApp":true,"function":"install","filename":"http://localhost:34611/build/client-050.js","lineno":355,"colno":18},{"inApp":true,"function":"init","filename":"http://localhost:34611/build/client-050.js","lineno":1585,"colno":17},{"inApp":true,"filename":"http://localhost:34611/app.js","lineno":22,"colno":3},{"inApp":true}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"2a0b76e4-8ef5-4db9-a9b9-4b5d8afb43e5"}}';

/** Firefox 151, 0.6.0 minified into an app bundle: the method names survive, the class is gone. */
const BEACON_060_MIN_FIREFOX =
  '{"sdk":{"name":"@uh-oh/js","version":"0.6.0"},"timestamp":"2026-10-04T03:41:39.858Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"\'setInterval\' called on an object that does not implement interface Window.","stacktrace":[{"inApp":true,"function":"updateRetryTimer","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":6738},{"inApp":true,"function":"drainLoop","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":5980},{"inApp":true,"function":"async*drainQueue","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":5734},{"inApp":true,"function":"captureWithException","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":2010},{"inApp":true,"function":"n","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":2,"colno":3680},{"inApp":true,"function":"EventListener.handleEvent*installBrowserHandlers","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":2,"colno":3768},{"inApp":true,"function":"install","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":2,"colno":3275},{"inApp":true,"function":"U","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":15868},{"inApp":true,"filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":16472},{"inApp":true}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"cae8f070-ccbc-4792-9bab-0917e2deaeb2"}}';

/**
 * WebKit 26.5, 0.5.0 unminified: the retry-loop report, as beaconed. The stack
 * starts with `setInterval@[native code]`, which the client's `slice(1)` dropped,
 * so the throw site is on top as a bare method name. (Playwright's WebKit sends
 * a macOS user agent on every host.)
 */
const BEACON_050_WEBKIT =
  '{"sdk":{"name":"@uh-oh/js","version":"0.5.0"},"timestamp":"2026-10-04T03:42:29.731Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Can only call Window.setInterval on instances of Window","stacktrace":[{"inApp":true,"function":"ensureRetryTimer","filename":"http://localhost:34611/build/client-050.js","lineno":882,"colno":45},{"inApp":true,"function":"updateRetryTimer","filename":"http://localhost:34611/build/client-050.js","lineno":873,"colno":34},{"inApp":true,"function":"drainLoop","filename":"http://localhost:34611/build/client-050.js","lineno":821,"colno":30}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"macOS","osVersion":"10.15.7","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"fca9333b-9c0c-44e1-a135-650d9f4dbab5"}}';

/** WebKit 26.5, 0.6.0 minified into an app bundle. */
const BEACON_060_MIN_WEBKIT =
  '{"sdk":{"name":"@uh-oh/js","version":"0.6.0"},"timestamp":"2026-10-04T03:42:59.270Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Can only call Window.setInterval on instances of Window","stacktrace":[{"inApp":true,"function":"ensureRetryTimer","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":6860},{"inApp":true,"function":"updateRetryTimer","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":6754},{"inApp":true,"function":"drainLoop","filename":"http://localhost:34611/build/bundle-060.min.js","lineno":3,"colno":5996}],"mechanism":"js-promise"},"breadcrumbs":[],"device":{"osName":"macOS","osVersion":"10.15.7","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"f48e4870-3c98-4d3b-a7fe-47bcd2882702"}}';

/** Firefox 151 and WebKit 26.5 messages for the two timers the client's reports carried. */
const FIREFOX_SET_TIMEOUT =
  "'setTimeout' called on an object that does not implement interface Window.";
const FIREFOX_SET_INTERVAL =
  "'setInterval' called on an object that does not implement interface Window.";
const WEBKIT_SET_TIMEOUT = 'Can only call Window.setTimeout on instances of Window';
const WEBKIT_SET_INTERVAL = 'Can only call Window.setInterval on instances of Window';

const parse = (raw: string): EventEnvelope => JSON.parse(raw) as EventEnvelope;

const frame = (fn: string, file: string, lineno: number, colno: number): StackFrame => ({
  inApp: true,
  function: fn,
  filename: `http://localhost:34611/build/${file}`,
  lineno,
  colno,
});

/** The envelope every old browser client builds (its buildEnvelope), as recorded. */
const oldClient = (
  version: string,
  exception: Partial<EventEnvelope['exception']>,
  eventId = '72eca792-b496-4a0b-9477-a27359819843',
): EventEnvelope => ({
  sdk: { name: '@uh-oh/js', version },
  timestamp: '2026-10-04T03:14:54.218Z',
  platform: 'web',
  release: { version: '1.4.2', build: '37' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'Illegal invocation',
    stacktrace: [],
    mechanism: 'js-promise',
    ...exception,
  },
  breadcrumbs: [],
  device: { osName: 'Windows', osVersion: '10.0', locale: 'en-US', timezone: 'America/New_York' },
  context: { environment: 'production', eventId },
});

/** Every recorded shape of the bug in Chromium 149: version x build x throw site. */
const CHROMIUM_SELF_REPORTS: Array<[string, EventEnvelope]> = [
  ['0.5.0 retry loop, beacon body', parse(BEACON_050)],
  ['0.6.0 minified retry loop, beacon body', parse(BEACON_060_MIN)],
  ['0.2.0 minified retry loop, beacon body', parse(BEACON_020_MIN)],
  [
    '0.5.0 minified retry loop',
    oldClient('0.5.0', {
      stacktrace: [
        frame('v.ensureRetryTimer', 'bundle-050.min.js', 3, 5480),
        frame('v.updateRetryTimer', 'bundle-050.min.js', 3, 5371),
        frame('v.drainLoop', 'bundle-050.min.js', 3, 4613),
      ],
    }),
  ],
  [
    '0.6.0 retry loop',
    oldClient('0.6.0', {
      stacktrace: [
        frame('Client.ensureRetryTimer', 'client-060.js', 829, 28),
        frame('Client.updateRetryTimer', 'client-060.js', 822, 12),
        frame('Client.drainLoop', 'client-060.js', 776, 10),
      ],
    }),
  ],
  [
    '0.5.0 checkIn()',
    oldClient('0.5.0', {
      stacktrace: [
        frame('Client.sendCheckIn', 'client-050.js', 601, 37),
        frame('Client.checkIn', 'client-050.js', 580, 17),
        frame('Module.checkIn', 'client-050.js', 1433, 14),
      ],
    }),
  ],
  [
    '0.5.0 minified checkIn()',
    oldClient('0.5.0', {
      stacktrace: [
        frame('v.sendCheckIn', 'bundle-050.min.js', 3, 3348),
        frame('v.checkIn', 'bundle-050.min.js', 3, 3147),
        frame('Object.Q', 'bundle-050.min.js', 3, 14992),
      ],
    }),
  ],
  [
    '0.6.0 checkIn()',
    oldClient('0.6.0', {
      stacktrace: [
        frame('Client.sendCheckIn', 'client-060.js', 693, 37),
        frame('Client.checkIn', 'client-060.js', 674, 17),
        frame('Module.checkIn', 'client-060.js', 1478, 14),
      ],
    }),
  ],
  [
    '0.6.0 minified checkIn()',
    oldClient('0.6.0', {
      stacktrace: [
        frame('b.sendCheckIn', 'bundle-060.min.js', 3, 4715),
        frame('b.checkIn', 'bundle-060.min.js', 3, 4514),
        frame('Object.V', 'bundle-060.min.js', 3, 16390),
      ],
    }),
  ],
  [
    '0.5.0 usage flush at 20 events',
    oldClient('0.5.0', {
      stacktrace: [
        frame('Client.sendAnalyticsBatch', 'client-050.js', 1181, 37),
        frame('Client.flushAnalytics', 'client-050.js', 1159, 17),
        frame('Client.enqueueAnalytics', 'client-050.js', 1124, 17),
        frame('Client.trackEvent', 'client-050.js', 1032, 12),
        frame('Module.trackEvent', 'client-050.js', 1445, 14),
      ],
    }),
  ],
  [
    '0.5.0 minified usage flush',
    oldClient('0.5.0', {
      stacktrace: [
        frame('v.sendAnalyticsBatch', 'bundle-050.min.js', 3, 11834),
        frame('v.flushAnalytics', 'bundle-050.min.js', 3, 11662),
        frame('v.enqueueAnalytics', 'bundle-050.min.js', 3, 11073),
        frame('v.trackEvent', 'bundle-050.min.js', 3, 9362),
        frame('Object.Y', 'bundle-050.min.js', 3, 15082),
      ],
    }),
  ],
  [
    '0.6.0 usage flush at 20 events',
    oldClient('0.6.0', {
      stacktrace: [
        frame('Client.sendAnalyticsBatch', 'client-060.js', 1242, 37),
        frame('Client.flushAnalytics', 'client-060.js', 1222, 17),
        frame('Client.enqueueAnalytics', 'client-060.js', 1190, 17),
        frame('Client.trackEvent', 'client-060.js', 1098, 12),
        frame('Module.trackEvent', 'client-060.js', 1490, 14),
      ],
    }),
  ],
  [
    '0.6.0 minified usage flush',
    oldClient('0.6.0', {
      stacktrace: [
        frame('b.sendAnalyticsBatch', 'bundle-060.min.js', 3, 13232),
        frame('b.flushAnalytics', 'bundle-060.min.js', 3, 13060),
        frame('b.enqueueAnalytics', 'bundle-060.min.js', 3, 12471),
        frame('b.trackEvent', 'bundle-060.min.js', 3, 10729),
        frame('Object.z', 'bundle-060.min.js', 3, 16480),
      ],
    }),
  ],
];

/**
 * Every recorded shape in Firefox 151. The top frame is the CALLER of the throw
 * site (updateRetryTimer, checkIn, flushAnalytics), not the throw site.
 */
const FIREFOX_SELF_REPORTS: Array<[string, EventEnvelope]> = [
  ['0.5.0 retry loop, beacon body', parse(BEACON_050_FIREFOX)],
  ['0.6.0 minified retry loop, beacon body', parse(BEACON_060_MIN_FIREFOX)],
  [
    '0.2.0 minified retry loop',
    oldClient('0.2.0', {
      value: FIREFOX_SET_INTERVAL,
      stacktrace: [
        frame('updateRetryTimer', 'bundle-020.min.js', 3, 4569),
        frame('drainLoop', 'bundle-020.min.js', 3, 3811),
        frame('async*drainQueue', 'bundle-020.min.js', 3, 3565),
      ],
    }),
  ],
  [
    '0.5.0 minified retry loop',
    oldClient('0.5.0', {
      value: FIREFOX_SET_INTERVAL,
      stacktrace: [
        frame('updateRetryTimer', 'bundle-050.min.js', 3, 5371),
        frame('drainLoop', 'bundle-050.min.js', 3, 4613),
        frame('async*drainQueue', 'bundle-050.min.js', 3, 4367),
      ],
    }),
  ],
  [
    '0.6.0 retry loop',
    oldClient('0.6.0', {
      value: FIREFOX_SET_INTERVAL,
      stacktrace: [
        frame('updateRetryTimer', 'client-060.js', 822, 12),
        frame('drainLoop', 'client-060.js', 776, 10),
        frame('async*drainQueue', 'client-060.js', 761, 31),
      ],
    }),
  ],
  [
    '0.5.0 checkIn()',
    oldClient('0.5.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('checkIn', 'client-050.js', 695, 23),
        frame('checkIn', 'client-050.js', 1659, 25),
      ],
    }),
  ],
  [
    '0.5.0 minified checkIn()',
    oldClient('0.5.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('checkIn', 'bundle-050.min.js', 3, 3147),
        frame('k', 'bundle-050.min.js', 3, 14634),
      ],
    }),
  ],
  [
    '0.6.0 checkIn()',
    oldClient('0.6.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('checkIn', 'client-060.js', 674, 17),
        frame('checkIn', 'client-060.js', 1478, 21),
      ],
    }),
  ],
  [
    '0.6.0 minified checkIn()',
    oldClient('0.6.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('checkIn', 'bundle-060.min.js', 3, 4514),
        frame('M', 'bundle-060.min.js', 3, 16032),
      ],
    }),
  ],
  [
    '0.5.0 usage flush at 20 events',
    oldClient('0.5.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('flushAnalytics', 'client-050.js', 1338, 21),
        frame('enqueueAnalytics', 'client-050.js', 1298, 23),
        frame('trackEvent', 'client-050.js', 1201, 18),
        frame('trackEvent', 'client-050.js', 1675, 28),
      ],
    }),
  ],
  [
    '0.5.0 minified usage flush',
    oldClient('0.5.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('flushAnalytics', 'bundle-050.min.js', 3, 11662),
        frame('enqueueAnalytics', 'bundle-050.min.js', 3, 11073),
        frame('trackEvent', 'bundle-050.min.js', 3, 9362),
        frame('U', 'bundle-050.min.js', 3, 14681),
      ],
    }),
  ],
  [
    '0.6.0 usage flush at 20 events',
    oldClient('0.6.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('flushAnalytics', 'client-060.js', 1222, 17),
        frame('enqueueAnalytics', 'client-060.js', 1190, 17),
        frame('trackEvent', 'client-060.js', 1098, 12),
        frame('trackEvent', 'client-060.js', 1490, 24),
      ],
    }),
  ],
  [
    '0.6.0 minified usage flush',
    oldClient('0.6.0', {
      value: FIREFOX_SET_TIMEOUT,
      stacktrace: [
        frame('flushAnalytics', 'bundle-060.min.js', 3, 13060),
        frame('enqueueAnalytics', 'bundle-060.min.js', 3, 12471),
        frame('trackEvent', 'bundle-060.min.js', 3, 10729),
        frame('F', 'bundle-060.min.js', 3, 16079),
      ],
    }),
  ],
];

/**
 * Every recorded shape in WebKit 26.5: the throw site on top, as in Chromium,
 * with a bare method name. JavaScriptCore runs `return this.sendAnalyticsBatch(...)`
 * as a tail call, so flushAnalytics is missing below the usage flush.
 */
const WEBKIT_SELF_REPORTS: Array<[string, EventEnvelope]> = [
  ['0.5.0 retry loop, beacon body', parse(BEACON_050_WEBKIT)],
  ['0.6.0 minified retry loop, beacon body', parse(BEACON_060_MIN_WEBKIT)],
  [
    '0.2.0 minified retry loop',
    oldClient('0.2.0', {
      value: WEBKIT_SET_INTERVAL,
      stacktrace: [
        frame('ensureRetryTimer', 'bundle-020.min.js', 3, 4691),
        frame('updateRetryTimer', 'bundle-020.min.js', 3, 4585),
        frame('drainLoop', 'bundle-020.min.js', 3, 3827),
      ],
    }),
  ],
  [
    '0.5.0 minified retry loop',
    oldClient('0.5.0', {
      value: WEBKIT_SET_INTERVAL,
      stacktrace: [
        frame('ensureRetryTimer', 'bundle-050.min.js', 3, 5493),
        frame('updateRetryTimer', 'bundle-050.min.js', 3, 5387),
        frame('drainLoop', 'bundle-050.min.js', 3, 4629),
      ],
    }),
  ],
  [
    '0.6.0 retry loop',
    oldClient('0.6.0', {
      value: WEBKIT_SET_INTERVAL,
      stacktrace: [
        frame('ensureRetryTimer', 'client-060.js', 829, 41),
        frame('updateRetryTimer', 'client-060.js', 822, 28),
        frame('drainLoop', 'client-060.js', 776, 26),
      ],
    }),
  ],
  [
    '0.5.0 checkIn()',
    oldClient('0.5.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendCheckIn', 'client-050.js', 719, 32),
        frame('checkIn', 'client-050.js', 695, 34),
        frame('checkIn', 'client-050.js', 1659, 25),
      ],
    }),
  ],
  [
    '0.5.0 minified checkIn()',
    oldClient('0.5.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendCheckIn', 'bundle-050.min.js', 3, 3360),
        frame('checkIn', 'bundle-050.min.js', 3, 3158),
        frame('k', 'bundle-050.min.js', 3, 14634),
      ],
    }),
  ],
  [
    '0.6.0 checkIn()',
    oldClient('0.6.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendCheckIn', 'client-060.js', 693, 49),
        frame('checkIn', 'client-060.js', 674, 28),
        frame('checkIn', 'client-060.js', 1478, 21),
      ],
    }),
  ],
  [
    '0.6.0 minified checkIn()',
    oldClient('0.6.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendCheckIn', 'bundle-060.min.js', 3, 4727),
        frame('checkIn', 'bundle-060.min.js', 3, 4525),
        frame('M', 'bundle-060.min.js', 3, 16032),
      ],
    }),
  ],
  [
    '0.5.0 usage flush at 20 events',
    oldClient('0.5.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendAnalyticsBatch', 'client-050.js', 1362, 32),
        frame('enqueueAnalytics', 'client-050.js', 1298, 37),
        frame('trackEvent', 'client-050.js', 1201, 34),
        frame('trackEvent', 'client-050.js', 1675, 28),
      ],
    }),
  ],
  [
    '0.5.0 minified usage flush',
    oldClient('0.5.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendAnalyticsBatch', 'bundle-050.min.js', 3, 11846),
        frame('enqueueAnalytics', 'bundle-050.min.js', 3, 11087),
        frame('trackEvent', 'bundle-050.min.js', 3, 9378),
        frame('U', 'bundle-050.min.js', 3, 14681),
      ],
    }),
  ],
  [
    '0.6.0 usage flush at 20 events',
    oldClient('0.6.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendAnalyticsBatch', 'client-060.js', 1242, 49),
        frame('enqueueAnalytics', 'client-060.js', 1190, 31),
        frame('trackEvent', 'client-060.js', 1098, 28),
        frame('trackEvent', 'client-060.js', 1490, 24),
      ],
    }),
  ],
  [
    '0.6.0 minified usage flush',
    oldClient('0.6.0', {
      value: WEBKIT_SET_TIMEOUT,
      stacktrace: [
        frame('sendAnalyticsBatch', 'bundle-060.min.js', 3, 13244),
        frame('enqueueAnalytics', 'bundle-060.min.js', 3, 12485),
        frame('trackEvent', 'bundle-060.min.js', 3, 10745),
        frame('F', 'bundle-060.min.js', 3, 16079),
      ],
    }),
  ],
];

const SELF_REPORTS: Array<[string, EventEnvelope]> = [
  ...CHROMIUM_SELF_REPORTS.map(([l, e]): [string, EventEnvelope] => [`Chromium ${l}`, e]),
  ...FIREFOX_SELF_REPORTS.map(([l, e]): [string, EventEnvelope] => [`Firefox ${l}`, e]),
  ...WEBKIT_SELF_REPORTS.map(([l, e]): [string, EventEnvelope] => [`WebKit ${l}`, e]),
];

/** Every recorded beacon body: the full 50 at pagehide were this report in each engine. */
const BEACONS: Array<[string, string]> = [
  ['Chromium 0.5.0', BEACON_050],
  ['Chromium 0.6.0', BEACON_060_MIN],
  ['Chromium 0.2.0', BEACON_020_MIN],
  ['Firefox 0.5.0', BEACON_050_FIREFOX],
  ['Firefox 0.6.0', BEACON_060_MIN_FIREFOX],
  ['WebKit 0.5.0', BEACON_050_WEBKIT],
  ['WebKit 0.6.0', BEACON_060_MIN_WEBKIT],
];

/** A genuine app crash from a 0.5.0 page: the same envelope shape, the app's own frame. */
const APP_TYPE_ERROR_050 = oldClient('0.5.0', {
  value: "Cannot read properties of undefined (reading 'id')",
  stacktrace: [frame('renderBoard', 'assets/board-9f2c.js', 1, 8812)],
  mechanism: 'js-global',
});

/** A genuine "Illegal invocation" in app code (an unbound DOM method) from a 0.5.0 page. */
const APP_ILLEGAL_INVOCATION_050 = oldClient('0.5.0', {
  stacktrace: [
    frame('findCard', 'assets/board-9f2c.js', 1, 9120),
    frame('HTMLButtonElement.onClick', 'assets/board-9f2c.js', 1, 9304),
  ],
  mechanism: 'js-global',
});

/**
 * An app's own unbound `history.pushState(...)` call, rethrown by the 0.6.0
 * client's pushState wrapper: client code is on the stack, but the bug is the
 * app's and the top frame is the wrapper, not a timer call site.
 */
const APP_PUSHSTATE_060 = oldClient('0.6.0', {
  stacktrace: [
    frame('wrapped', 'client-060.js', 1301, 30),
    frame('navigate', 'assets/router-1a2b.js', 1, 412),
  ],
  mechanism: 'js-global',
});

/**
 * The app's OWN unbound window timer (`appTimers.schedule(...)` in
 * `scheduleAutosave`, called from `onCardDropped`) on a 0.5.0 page in Firefox
 * 151, as queued: Firefox's wording, but the frame on top (the caller, as for
 * the client's own reports) is app code, so it is stored.
 */
const APP_TIMER_050_FIREFOX =
  '{"sdk":{"name":"@uh-oh/js","version":"0.5.0"},"timestamp":"2026-10-04T03:49:44.566Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"\'setTimeout\' called on an object that does not implement interface Window.","stacktrace":[{"inApp":true,"function":"onCardDropped","filename":"http://localhost:34611/app.js","lineno":43,"colno":3},{"inApp":true,"function":"setTimeout handler*runScenario","filename":"http://localhost:34611/app.js","lineno":48,"colno":47},{"inApp":true,"function":"setTimeout handler*","filename":"http://localhost:34611/app.js","lineno":55,"colno":11},{"inApp":true}],"mechanism":"js-global"},"breadcrumbs":[],"device":{"osName":"Windows","osVersion":"10.0","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"cbc3648e-e94b-4e62-8cf9-77bd8fb4f30e"}}';

/** The same app bug on a 0.6.0 page in WebKit 26.5, as queued: the app's throw site on top. */
const APP_TIMER_060_WEBKIT =
  '{"sdk":{"name":"@uh-oh/js","version":"0.6.0"},"timestamp":"2026-10-04T03:49:57.692Z","platform":"web","release":{"version":"1.4.2","build":"37"},"level":"error","exception":{"type":"TypeError","value":"Can only call Window.setTimeout on instances of Window","stacktrace":[{"inApp":true,"function":"scheduleAutosave","filename":"http://localhost:34611/app.js","lineno":40,"colno":21},{"inApp":true,"function":"onCardDropped","filename":"http://localhost:34611/app.js","lineno":43,"colno":19}],"mechanism":"js-global"},"breadcrumbs":[],"device":{"osName":"macOS","osVersion":"10.15.7","locale":"en-US","timezone":"America/New_York"},"context":{"environment":"production","eventId":"6d272ecf-8fc6-4d8b-a064-448270730f83"}}';

// ---------------------------------------------------------------------------
// The predicate.
// ---------------------------------------------------------------------------

describe('isOldClientSelfReport', () => {
  it.each(SELF_REPORTS)('recognises the recorded %s', (_label, env) => {
    expect(isOldClientSelfReport(env)).toBe(true);
  });

  const topMethod = (env: EventEnvelope): string => {
    const top = env.exception.stacktrace[0]?.function ?? '';
    return top.slice(top.lastIndexOf('.') + 1);
  };

  it('in Chromium and WebKit every recorded top frame is the throw site, a client timer method', () => {
    for (const [label, env] of [...CHROMIUM_SELF_REPORTS, ...WEBKIT_SELF_REPORTS]) {
      expect(CLIENT_TIMER_METHODS.has(topMethod(env)), label).toBe(true);
    }
  });

  it('in Firefox every recorded top frame is the client method that called the throw site', () => {
    for (const [label, env] of FIREFOX_SELF_REPORTS) {
      expect(CLIENT_TIMER_CALLERS.has(topMethod(env)), label).toBe(true);
      expect(CLIENT_TIMER_METHODS.has(topMethod(env)), label).toBe(false);
    }
  });

  it("pairs each wording with its engine's top frame, never another engine's", () => {
    // Chromium's or Safari's wording over Firefox's frames: the caller is on top, not a timer method.
    for (const value of ['Illegal invocation', WEBKIT_SET_INTERVAL]) {
      const env = parse(BEACON_050_FIREFOX);
      env.exception.value = value;
      expect(isOldClientSelfReport(env), value).toBe(false);
    }
    // Firefox's wording over Chromium's or Safari's frames: a timer method on top is not
    // what Firefox leaves there.
    for (const raw of [BEACON_050, BEACON_050_WEBKIT]) {
      const env = parse(raw);
      env.exception.value = FIREFOX_SET_INTERVAL;
      expect(isOldClientSelfReport(env)).toBe(false);
    }
  });

  it('leaves a genuine TypeError from an old client alone', () => {
    expect(isOldClientSelfReport(APP_TYPE_ERROR_050)).toBe(false);
  });

  it('leaves a genuine "Illegal invocation" thrown in app code alone', () => {
    expect(isOldClientSelfReport(APP_ILLEGAL_INVOCATION_050)).toBe(false);
    expect(isOldClientSelfReport(APP_PUSHSTATE_060)).toBe(false);
  });

  it("leaves the app's own unbound timer alone in Firefox and WebKit (recorded)", () => {
    expect(isOldClientSelfReport(parse(APP_TIMER_050_FIREFOX))).toBe(false);
    expect(isOldClientSelfReport(parse(APP_TIMER_060_WEBKIT))).toBe(false);
  });

  it('needs the client method at the top: below an app frame it is not the client bug', () => {
    for (const raw of [BEACON_050, BEACON_050_FIREFOX, BEACON_050_WEBKIT]) {
      const loop = parse(raw);
      const env = oldClient('0.5.0', {
        value: loop.exception.value,
        stacktrace: [
          frame('copyLink', 'assets/share-77aa.js', 1, 210),
          ...loop.exception.stacktrace,
        ],
      });
      expect(isOldClientSelfReport(env), loop.exception.value).toBe(false);
    }
  });

  it('never applies to a fixed client (0.6.1 and later, compared numerically)', () => {
    for (const [label, raw] of BEACONS) {
      for (const version of ['0.6.1', '0.6.2', '0.7.0', '0.10.0', '1.0.0']) {
        const env = parse(raw);
        env.sdk.version = version;
        expect(isOldClientSelfReport(env), `${label} as ${version}`).toBe(false);
      }
    }
  });

  it('treats a missing sdk version as old', () => {
    const env = parse(BEACON_050);
    Reflect.deleteProperty(env.sdk, 'version');
    expect(env.sdk.version).toBeUndefined();
    expect(isOldClientSelfReport(env)).toBe(true);
  });

  it('only applies to the @uh-oh/js client', () => {
    const env = parse(BEACON_050);
    env.sdk.name = '@uh-oh/react-native';
    expect(isOldClientSelfReport(env)).toBe(false);
  });

  it("needs a TypeError in one engine's wording for this error", () => {
    for (const [label, raw] of BEACONS) {
      const notType = parse(raw);
      notType.exception.type = 'Error';
      expect(isOldClientSelfReport(notType), label).toBe(false);

      const otherMessage = parse(raw);
      otherMessage.exception.value = 'Failed to fetch';
      expect(isOldClientSelfReport(otherMessage), label).toBe(false);
    }
  });

  it('matches each engine wording for all four window timers, as probed', () => {
    const wordingOf = (value: string) =>
      TIMER_BUG_WORDINGS.find((w) => w.message.test(value))?.engine;
    for (const timer of ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']) {
      expect(wordingOf('Illegal invocation'), timer).toBe('chromium');
      expect(
        wordingOf(`'${timer}' called on an object that does not implement interface Window.`),
        timer,
      ).toBe('firefox');
      expect(wordingOf(`Can only call Window.${timer} on instances of Window`), timer).toBe(
        'webkit',
      );
    }
  });

  it('does not take the same template for another method or interface', () => {
    for (const value of [
      "'getComputedStyle' called on an object that does not implement interface Window.",
      "'setTimeout' called on an object that does not implement interface WorkerGlobalScope.",
      "'setTimeout' called on an object that does not implement interface Window. (in app.js)",
      'Can only call Window.fetch on instances of Window',
      'Can only call Document.createElement on instances of Document',
      'Can only call Window.setTimeoutX on instances of Window',
    ]) {
      const env = parse(BEACON_050_FIREFOX);
      env.exception.value = value;
      expect(isOldClientSelfReport(env), value).toBe(false);
      const wk = parse(BEACON_050_WEBKIT);
      wk.exception.value = value;
      expect(isOldClientSelfReport(wk), value).toBe(false);
    }
  });

  it('needs a named top frame', () => {
    expect(isOldClientSelfReport(oldClient('0.5.0', { stacktrace: [] }))).toBe(false);
    const unnamed = parse(BEACON_050);
    unnamed.exception.stacktrace[0] = { inApp: true };
    expect(isOldClientSelfReport(unnamed)).toBe(false);
  });

  it('reads the method through the V8 decorations the client keeps in `function`', () => {
    for (const fn of [
      'async Client.sendOne',
      'Client.ensureRetryTimer [as retry]',
      'ensureRetryTimer',
      'Object.ensureRetryTimer',
    ]) {
      const env = oldClient('0.6.0', { stacktrace: [{ inApp: true, function: fn }] });
      expect(isOldClientSelfReport(env), fn).toBe(true);
    }
    for (const fn of ['Client.drainLoop', 'Client.ensureRetryTimerX', 'ensureRetryTimer.x']) {
      const env = oldClient('0.6.0', { stacktrace: [{ inApp: true, function: fn }] });
      expect(isOldClientSelfReport(env), fn).toBe(false);
    }
  });

  it("reads the method through Firefox's async-cause prefix", () => {
    for (const fn of [
      'updateRetryTimer',
      'async*updateRetryTimer',
      'promise callback*flushAnalytics',
      'EventListener.handleEvent*checkIn',
    ]) {
      const env = oldClient('0.6.0', {
        value: FIREFOX_SET_TIMEOUT,
        stacktrace: [{ inApp: true, function: fn }],
      });
      expect(isOldClientSelfReport(env), fn).toBe(true);
    }
    // An arrow function inside a caller is not the caller, and a bare cause is no method.
    for (const fn of ['updateRetryTimer/<', 'setTimeout handler*', 'async*drainLoop']) {
      const env = oldClient('0.6.0', {
        value: FIREFOX_SET_TIMEOUT,
        stacktrace: [{ inApp: true, function: fn }],
      });
      expect(isOldClientSelfReport(env), fn).toBe(false);
    }
  });
});

describe('isBeforeFixedJsClient', () => {
  it.each([
    ['0.2.0', true],
    ['0.5.0', true],
    ['0.6.0', true],
    ['0.6.0-beta.1', true],
    ['0.6.1-rc.1', true],
    ['v0.5.0', true],
    ['0.6', true],
    ['0.6.1', false],
    ['0.6.1+build.7', false],
    ['v0.6.1', false],
    ['0.6.2', false],
    ['0.7', false],
    ['0.10.0', false],
    ['1.0.0', false],
    ['10.0.0', false],
  ])('%s -> %s', (version, old) => {
    expect(isBeforeFixedJsClient(version)).toBe(old);
  });

  it('counts a missing, empty or unparseable version as old', () => {
    expect(isBeforeFixedJsClient(undefined)).toBe(true);
    expect(isBeforeFixedJsClient('')).toBe(true);
    expect(isBeforeFixedJsClient('dev')).toBe(true);
    expect(isBeforeFixedJsClient('0.x.1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route and ingest().
// ---------------------------------------------------------------------------

let db: Db;
let close: () => void;
let project: ProjectRow;

beforeEach(() => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'Kanban', webhookUrl: 'https://hooks.test/kanban' });
});
afterEach(() => close());

const SITE = 'https://kanban.example.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = () =>
  buildServer({
    db,
    secret: TEST_SECRET,
    password: 'test-password',
    defaultWebhookUrl: 'https://hooks.example/instance',
  });

/** POST a raw body the way a beacon or fetch does. */
const post = (
  server: ReturnType<typeof app>,
  body: string,
  contentType: 'application/json' | 'text/plain;charset=UTF-8',
  publicKey = project.publicKey,
) =>
  server.inject({
    method: 'POST',
    url: `/ingest/${publicKey}`,
    headers: { origin: SITE, 'content-type': contentType },
    payload: body,
  });

const storedEventCount = (): number => db.select().from(events).all().length;

type MetricValue = { value: number; labels: Record<string, string | number> };
const droppedFor = async (slug: string): Promise<number> => {
  const raw = (await Promise.resolve(metrics.oldClientReportsDropped.get())) as unknown as {
    values: MetricValue[];
  };
  return raw.values
    .filter((v) => v.labels['project'] === slug)
    .reduce((sum, v) => sum + v.value, 0);
};

describe('POST /ingest/:publicKey drops old clients self-reports', () => {
  for (const [label, body, contentType] of [
    ['0.5.0, application/json (the old pagehide beacon)', BEACON_050, 'application/json'],
    ['0.6.0, application/json (the old pagehide beacon)', BEACON_060_MIN, 'application/json'],
    ['0.2.0, application/json (the old pagehide beacon)', BEACON_020_MIN, 'application/json'],
    ['0.5.0, text/plain', BEACON_050, 'text/plain;charset=UTF-8'],
    ['0.6.0, text/plain', BEACON_060_MIN, 'text/plain;charset=UTF-8'],
    [
      'Firefox 0.5.0, application/json (the old pagehide beacon)',
      BEACON_050_FIREFOX,
      'application/json',
    ],
    [
      'Firefox 0.6.0, application/json (the old pagehide beacon)',
      BEACON_060_MIN_FIREFOX,
      'application/json',
    ],
    ['Firefox 0.5.0, text/plain', BEACON_050_FIREFOX, 'text/plain;charset=UTF-8'],
    [
      'WebKit 0.5.0, application/json (the old pagehide beacon)',
      BEACON_050_WEBKIT,
      'application/json',
    ],
    [
      'WebKit 0.6.0, application/json (the old pagehide beacon)',
      BEACON_060_MIN_WEBKIT,
      'application/json',
    ],
    ['WebKit 0.6.0, text/plain', BEACON_060_MIN_WEBKIT, 'text/plain;charset=UTF-8'],
  ] as const) {
    it(`${label}: 202 like a stored event, nothing stored, no alert`, async () => {
      const before = await droppedFor(project.slug);
      const res = await post(app(), body, contentType);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ eventId: expect.stringMatching(UUID) as unknown });
      expect(res.headers['access-control-allow-origin']).toBe(SITE);

      expect(storedEventCount()).toBe(0);
      expect(listIssues(db, { projectId: project.id }).total).toBe(0);
      expect(listReleasesForProject(db, project.id)).toHaveLength(0);
      expect(takeDueDispatches(db, Date.now() + 60_000, 10)).toHaveLength(0);
      expect(await droppedFor(project.slug)).toBe(before + 1);
    });
  }

  it('answers with the same status and body shape as a stored event', async () => {
    const server = app();
    const dropped = await post(server, BEACON_050, 'application/json');
    const stored = await post(server, JSON.stringify(APP_TYPE_ERROR_050), 'application/json');
    expect(dropped.statusCode).toBe(stored.statusCode);
    expect(Object.keys(dropped.json<object>())).toEqual(Object.keys(stored.json<object>()));
    expect(dropped.json<{ eventId: string }>().eventId).toMatch(UUID);
    expect(stored.json<{ eventId: string }>().eventId).toMatch(UUID);
  });

  it('still answers 401 for an unknown key, as a stored event would', async () => {
    const res = await post(app(), BEACON_050, 'application/json', 'not-a-key');
    expect(res.statusCode).toBe(401);
  });

  it("stores an old client's genuine errors, including a genuine unbound-timer TypeError", async () => {
    const server = app();
    for (const body of [
      JSON.stringify(APP_TYPE_ERROR_050),
      JSON.stringify(APP_ILLEGAL_INVOCATION_050),
      JSON.stringify(APP_PUSHSTATE_060),
      APP_TIMER_050_FIREFOX,
      APP_TIMER_060_WEBKIT,
    ]) {
      const res = await post(server, body, 'text/plain;charset=UTF-8');
      expect(res.statusCode).toBe(202);
    }
    expect(storedEventCount()).toBe(5);
    expect(listIssues(db, { projectId: project.id }).total).toBe(5);
    // Each one is a new issue with a webhook target, so each alerts.
    expect(takeDueDispatches(db, Date.now() + 60_000, 10)).toHaveLength(5);
  });

  for (const [engine, beacon] of [
    ['Chromium', BEACON_050],
    ['Firefox', BEACON_050_FIREFOX],
    ['WebKit', BEACON_050_WEBKIT],
  ] as const) {
    it(`${engine}: a full old queue at pagehide (49 self-reports and the real crash) stores only the crash`, async () => {
      const server = app();
      const loop = parse(beacon);
      for (let i = 0; i < 49; i++) {
        const env = { ...loop, context: { ...loop.context, eventId: `loop-${String(i)}` } };
        expect((await post(server, JSON.stringify(env), 'application/json')).statusCode).toBe(202);
      }
      const crash = await post(server, JSON.stringify(APP_TYPE_ERROR_050), 'application/json');
      expect(crash.statusCode).toBe(202);

      expect(storedEventCount()).toBe(1);
      const issues = listIssues(db, { projectId: project.id });
      expect(issues.total).toBe(1);
      expect(issues.rows[0]?.title).toContain('Cannot read properties of undefined');
      expect(takeDueDispatches(db, Date.now() + 60_000, 10)).toHaveLength(1);
    });
  }

  it('counts drops per project', async () => {
    const other = createProject(db, { name: 'Spoonworks' });
    const server = app();
    const beforeA = await droppedFor(project.slug);
    const beforeB = await droppedFor(other.slug);
    for (let i = 0; i < 3; i++) await post(server, BEACON_050, 'application/json');
    await post(server, BEACON_060_MIN, 'text/plain;charset=UTF-8', other.publicKey);

    expect(await droppedFor(project.slug)).toBe(beforeA + 3);
    expect(await droppedFor(other.slug)).toBe(beforeB + 1);
    const text = await server.inject({ method: 'GET', url: '/metrics' });
    expect(text.body).toContain(`uh_oh_old_client_reports_dropped_total{project="${other.slug}"}`);
    expect(text.body).not.toContain(other.publicKey);
  });

  it('logs the drop as one structured info line naming the project, never its key', async () => {
    const server = app();
    const log = captureLog();
    const info = forwardLevel(server.log, 'info', log.logger);
    try {
      expect((await post(server, BEACON_050, 'application/json')).statusCode).toBe(202);
    } finally {
      info.mockRestore();
    }
    const lines = log.lines.filter((l) => String(l['msg']).startsWith('dropped an @uh-oh/js'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      projectId: project.id,
      project: 'Kanban',
      slug: project.slug,
      sdkVersion: '0.5.0',
      dropped: 1,
      droppedSinceLastLine: 1,
    });
    expect(String(lines[0]?.['msg'])).toContain('re-vendor');
    expect(JSON.stringify(lines[0])).not.toContain(project.publicKey);
  });
});

describe('ingest() with an old client self-report', () => {
  it("returns 'dropped' and leaves the fingerprint rate limit untouched", () => {
    const rateLimiter = createRateLimiter({ capacity: 1, refillPerSec: 0 });
    const deps = { db, rateLimiter, now: () => 1_000 };
    for (let i = 0; i < 5; i++) {
      const r = ingestFn(deps, project.publicKey, parse(BEACON_060_MIN));
      expect(r.kind).toBe('dropped');
      if (r.kind === 'dropped') expect(r.eventId).toMatch(UUID);
    }
    // The bucket's single token is still there for a real crash.
    expect(ingestFn(deps, project.publicKey, APP_TYPE_ERROR_050).kind).toBe('stored');
  });

  it('logs the first drop per project, then at most once per interval with the running count', () => {
    const info = vi.fn();
    const rateLimiter = createRateLimiter({ capacity: 10, refillPerSec: 1 });
    let t = 5_000_000;
    const deps = { db, rateLimiter, now: () => t, logger: { info } };
    const drop = (at: number) => {
      t = at;
      expect(ingestFn(deps, project.publicKey, parse(BEACON_050)).kind).toBe('dropped');
    };

    drop(5_000_000);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ dropped: 1, droppedSinceLastLine: 1 });

    drop(5_000_001);
    drop(5_000_000 + OLD_CLIENT_DROP_LOG_INTERVAL_MS - 1);
    expect(info).toHaveBeenCalledTimes(1);

    drop(5_000_000 + OLD_CLIENT_DROP_LOG_INTERVAL_MS);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1]?.[1]).toMatchObject({ dropped: 4, droppedSinceLastLine: 3 });

    // A second project gets its own first line straight away.
    const other = createProject(db, { name: 'Opening Bell' });
    t += 1;
    expect(ingestFn(deps, other.publicKey, parse(BEACON_020_MIN)).kind).toBe('dropped');
    expect(info).toHaveBeenCalledTimes(3);
    expect(info.mock.calls[2]?.[1]).toMatchObject({
      projectId: other.id,
      sdkVersion: '0.2.0',
      dropped: 1,
    });
  });
});
