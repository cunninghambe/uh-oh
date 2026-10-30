// err.stack across engines. V8 (Chrome, Node) starts a stack with the error's
// "Name: message" header, over several lines when the message has them.
// JavaScriptCore (Safari) and SpiderMonkey (Firefox) have no header: their
// first line is the top frame. Up to 0.6.1 the client dropped the first line
// of every stack, so a Safari or Firefox report lost its top frame (a
// one-frame Safari error arrived with no frames at all) and the server grouped
// on whatever frame was left, or on none.
//
// The stacks are real. Chromium 149 and WebKit 26.5 were recorded with
// Playwright 1.61.1 from a page loading app.js from http://127.0.0.1:4731
// (the samples below name the line each one threw from). Firefox 151 is the
// SPEC §25 recording behind BEACON_050_FIREFOX in the server's
// old-client-guard.test.ts: the frames that beacon carries, its dropped top
// line (named in that file's comment) put back, and the trailing newline.

import { describe, expect, it } from 'vitest';

import { Client, type StackFrame } from './uh-oh-client.js';
import { fakeProcess, mockFetch } from './test-support.js';

const DSN = 'https://pk@errors.example.com';
const APP = 'http://127.0.0.1:4731/app.js';

/** A real error carrying a recorded engine's name, message and stack. */
function recorded(name: string, message: string, stack: string): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = stack;
  return e;
}

async function framesOf(err: unknown): Promise<StackFrame[]> {
  const f = mockFetch();
  const c = new Client({ dsn: DSN, release: '1.0.0' }, { fetchFn: f.fn, proc: fakeProcess().proc });
  c.captureException(err);
  await c.flush();
  c.close();
  const [call] = f.calls;
  if (!call) throw new Error('expected one fetch call');
  return call.env.exception.stacktrace;
}

const at = (fn: string | undefined, lineno: number, colno: number, filename = APP): StackFrame => ({
  inApp: true,
  ...(fn !== undefined ? { function: fn } : {}),
  filename,
  lineno,
  colno,
});

// Chromium 149. app.js: line 6 throws in top-level code; steer() (line 11) is
// called by drive() (14) from top-level code (17); loadSave() (22) hands
// JSON.parse a bad save (from 25); multi() (30) throws a two-line message.
const CHROME = {
  oneFrame: recorded(
    'Error',
    'lap timer broke',
    'Error: lap timer broke\n    at http://127.0.0.1:4731/app.js:6:9',
  ),
  nested: recorded(
    'TypeError',
    'kart wheel fell off',
    'TypeError: kart wheel fell off\n' +
      '    at steer (http://127.0.0.1:4731/app.js:11:9)\n' +
      '    at drive (http://127.0.0.1:4731/app.js:14:3)\n' +
      '    at http://127.0.0.1:4731/app.js:17:3',
  ),
  native: recorded(
    'SyntaxError',
    "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    "SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)\n" +
      '    at JSON.parse (<anonymous>)\n' +
      '    at loadSave (http://127.0.0.1:4731/app.js:22:15)\n' +
      '    at http://127.0.0.1:4731/app.js:25:3',
  ),
  multiLine: recorded(
    'Error',
    'line one\nline two',
    'Error: line one\nline two\n' +
      '    at multi (http://127.0.0.1:4731/app.js:30:9)\n' +
      '    at http://127.0.0.1:4731/app.js:33:3',
  ),
};

// WebKit 26.5, the same page.
const SAFARI = {
  oneFrame: recorded('Error', 'lap timer broke', 'global code@http://127.0.0.1:4731/app.js:6:18'),
  nested: recorded(
    'TypeError',
    'kart wheel fell off',
    'steer@http://127.0.0.1:4731/app.js:11:22\n' +
      'drive@http://127.0.0.1:4731/app.js:14:8\n' +
      'global code@http://127.0.0.1:4731/app.js:17:8',
  ),
  native: recorded(
    'SyntaxError',
    "JSON Parse error: Expected '}'",
    'parse@[native code]\n' +
      'loadSave@http://127.0.0.1:4731/app.js:22:20\n' +
      'global code@http://127.0.0.1:4731/app.js:25:11',
  ),
  multiLine: recorded(
    'Error',
    'line one\nline two',
    'multi@http://127.0.0.1:4731/app.js:30:18\n' + 'global code@http://127.0.0.1:4731/app.js:33:8',
  ),
};

// Firefox 151: the 0.5.0 client's own retry-loop TypeError, thrown in
// ensureRetryTimer, reached from app.js line 22 through init().
const FF_CLIENT = 'http://localhost:34611/build/client-050.js';
const FIREFOX = recorded(
  'TypeError',
  "'setInterval' called on an object that does not implement interface Window.",
  `ensureRetryTimer@${FF_CLIENT}:882:32\n` +
    `updateRetryTimer@${FF_CLIENT}:873:18\n` +
    `drainLoop@${FF_CLIENT}:821:14\n` +
    `async*drainQueue@${FF_CLIENT}:805:35\n` +
    `captureWithException@${FF_CLIENT}:548:23\n` +
    `onRejection@${FF_CLIENT}:379:22\n` +
    `EventListener.handleEvent*installBrowserHandlers@${FF_CLIENT}:382:20\n` +
    `install@${FF_CLIENT}:355:18\n` +
    `init@${FF_CLIENT}:1585:17\n` +
    '@http://localhost:34611/app.js:22:3\n',
);

describe('Chrome (V8): the header goes, every frame stays', () => {
  it('a one-frame error keeps its frame', async () => {
    expect(await framesOf(CHROME.oneFrame)).toEqual([at(undefined, 6, 9)]);
  });

  it('a nested error keeps the throw site on top', async () => {
    expect(await framesOf(CHROME.nested)).toEqual([
      at('steer', 11, 9),
      at('drive', 14, 3),
      at(undefined, 17, 3),
    ]);
  });

  it("V8's location-less native frame stays a bare frame, as before", async () => {
    expect(await framesOf(CHROME.native)).toEqual([
      { inApp: true },
      at('loadSave', 22, 15),
      at(undefined, 25, 3),
    ]);
  });

  it("a message's second line is header, not a frame", async () => {
    // 0.6.1 sent "line two" as a bare first frame, which the server grouped on.
    expect(await framesOf(CHROME.multiLine)).toEqual([at('multi', 30, 9), at(undefined, 33, 3)]);
  });

  it('a header that no longer matches the message still goes', async () => {
    // V8 writes the header when .stack is first read; a message changed after
    // that ("context: " + message) no longer matches it.
    const e = recorded(
      'TypeError',
      'kart wheel fell off',
      String(CHROME.nested.stack).replace('kart wheel', 'old kart wheel'),
    );
    e.message = 'while racing: kart wheel fell off';
    expect(await framesOf(e)).toEqual(await framesOf(CHROME.nested));
  });

  it('a stack that is only the header has no frames', async () => {
    // Error.stackTraceLimit = 0, here with an "@" a frame test would accept.
    const e = recorded('Error', 'no racer kid@example.com', 'Error: no racer kid@example.com');
    expect(await framesOf(e)).toEqual([]);
  });
});

describe('Safari (JavaScriptCore): no header, the first line is the top frame', () => {
  it('a one-frame error keeps its one frame (0.6.1 sent none)', async () => {
    expect(await framesOf(SAFARI.oneFrame)).toEqual([at('global code', 6, 18)]);
  });

  it('a nested error keeps the throw site on top (0.6.1 started at drive)', async () => {
    expect(await framesOf(SAFARI.nested)).toEqual([
      at('steer', 11, 22),
      at('drive', 14, 8),
      at('global code', 17, 8),
    ]);
  });

  it('a native frame on top is kept, named and not in-app', async () => {
    // Parsed as a bare in-app frame, it would be the frame the server groups
    // every such error on; as [native code] the server skips it (fingerprint.ts).
    expect(await framesOf(SAFARI.native)).toEqual([
      { inApp: false, function: 'parse', filename: '[native code]' },
      at('loadSave', 22, 20),
      at('global code', 25, 11),
    ]);
  });

  it('a multi-line message adds nothing to the stack', async () => {
    expect(await framesOf(SAFARI.multiLine)).toEqual([
      at('multi', 30, 18),
      at('global code', 33, 8),
    ]);
  });
});

describe('Firefox (SpiderMonkey): no header, and a trailing newline', () => {
  it('keeps the throw site and sends no bare frame for the trailing newline', async () => {
    const frames = await framesOf(FIREFOX);
    // 0.6.1 sent updateRetryTimer on top and a bare { inApp: true } last.
    expect(frames[0]).toEqual(at('ensureRetryTimer', 882, 32, FF_CLIENT));
    expect(frames[3]).toEqual(at('async*drainQueue', 805, 35, FF_CLIENT));
    expect(frames[6]).toEqual(
      at('EventListener.handleEvent*installBrowserHandlers', 382, 20, FF_CLIENT),
    );
    expect(frames.at(-1)).toEqual(at(undefined, 22, 3, 'http://localhost:34611/app.js'));
    expect(frames).toHaveLength(10);
  });

  it('a one-frame error from top-level code keeps its frame', async () => {
    // The recording's last frame on its own: what top-level code throws.
    const e = recorded('Error', 'lap timer broke', '@http://localhost:34611/app.js:22:3\n');
    expect(await framesOf(e)).toEqual([at(undefined, 22, 3, 'http://localhost:34611/app.js')]);
  });
});

describe('a header the error names in its own way', () => {
  it("a stack that starts with the error's toString() loses exactly that", async () => {
    const e = {
      name: 'MailError',
      message: 'bounced',
      toString: () => 'MailError(550) for kid@example.com: bounced',
      stack: 'MailError(550) for kid@example.com: bounced\nsend@http://127.0.0.1:4731/app.js:40:7',
    };
    expect(await framesOf(e)).toEqual([at('send', 40, 7)]);
  });

  it("a wrapper's own one-word header (Crash Kart's toReportable) still goes", async () => {
    // Crash Kart hands 0.6.1 { name, message, stack: "Error\n" + frame lines }
    // so that the line 0.6.1 drops is its own. Both engines must come out as
    // if the raw stack had been sent.
    const frameLines = (stack: string): string =>
      stack
        .split('\n')
        .filter((l) => /^\s*at\s/.test(l) || l.includes('@'))
        .join('\n');
    for (const err of [CHROME.nested, SAFARI.nested, SAFARI.oneFrame, FIREFOX]) {
      const wrapped = {
        name: err.name,
        message: err.message,
        stack: `Error\n${frameLines(String(err.stack))}`,
      };
      expect(await framesOf(wrapped)).toEqual(await framesOf(err));
    }
  });
});
