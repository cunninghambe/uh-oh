// Pure helpers for CodeContext.tsx (v0.5 CONTRACT S), split out for unit testing without
// rendering.

import type { FrameContext } from '../api.js';

export type CodeContextRow = {
  key: string;
  lineNumber: number | null;
  text: string;
  isCrashLine: boolean;
};

/** Renders a tab as two spaces so indentation stays consistent regardless of the viewer's
 * browser/font tab-size (brief: "preserve indentation ... render tabs as 2 spaces
 * consistently"). Right-trimming/length-capping already happened server-side (CONTRACT S). */
export const expandTabs = (line: string): string => line.replace(/\t/g, '  ');

/**
 * Builds the rows for a frame's source-context block: `pre` lines numbered backwards from the
 * crash line, the crash line itself (flagged for highlighting), then `post` lines numbered
 * forwards. `lineno` is the frame's *resolved* line number (brief: "line numbers derived from
 * the resolved `line`"); when it's absent — defensive, since the server only attaches `context`
 * to frames it could also resolve a line number for — every row's line number is `null` and the
 * caller renders a blank gutter rather than guessing.
 */
export const codeContextRows = (
  context: FrameContext,
  lineno: number | undefined,
): CodeContextRow[] => {
  const pre = context.pre.map((raw, i) => {
    const offsetFromCrash = context.pre.length - i;
    return {
      key: `pre-${String(i)}`,
      lineNumber: lineno !== undefined ? lineno - offsetFromCrash : null,
      text: expandTabs(raw),
      isCrashLine: false,
    };
  });

  const crash: CodeContextRow = {
    key: 'line',
    lineNumber: lineno ?? null,
    text: expandTabs(context.line),
    isCrashLine: true,
  };

  const post = context.post.map((raw, i) => ({
    key: `post-${String(i)}`,
    lineNumber: lineno !== undefined ? lineno + i + 1 : null,
    text: expandTabs(raw),
    isCrashLine: false,
  }));

  return [...pre, crash, ...post];
};
