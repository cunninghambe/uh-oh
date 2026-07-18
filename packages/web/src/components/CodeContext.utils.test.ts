import { describe, expect, it } from 'vitest';

import type { FrameContext } from '../api.js';
import { codeContextRows, expandTabs } from './CodeContext.utils.js';

describe('expandTabs', () => {
  it('replaces each tab with two spaces', () => {
    expect(expandTabs('\tif (x) {')).toBe('  if (x) {');
  });

  it('handles multiple/mixed indentation', () => {
    expect(expandTabs('\t\tconst x = 1;')).toBe('    const x = 1;');
  });

  it('leaves lines with no tabs untouched', () => {
    expect(expandTabs('    const x = 1;')).toBe('    const x = 1;');
  });
});

describe('codeContextRows', () => {
  const context: FrameContext = {
    pre: ['function f() {', '  const a = 1;'],
    line: '  throw new Error("boom");',
    post: ['  return a;', '}'],
  };

  it('numbers pre/line/post lines relative to the resolved lineno', () => {
    const rows = codeContextRows(context, 10);
    expect(rows.map((r) => [r.lineNumber, r.text, r.isCrashLine])).toEqual([
      [8, 'function f() {', false],
      [9, '  const a = 1;', false],
      [10, '  throw new Error("boom");', true],
      [11, '  return a;', false],
      [12, '}', false],
    ]);
  });

  it('marks exactly one row as the crash line', () => {
    const rows = codeContextRows(context, 10);
    expect(rows.filter((r) => r.isCrashLine)).toHaveLength(1);
  });

  it('preserves ordering: pre, then line, then post', () => {
    const rows = codeContextRows(context, 10);
    expect(rows).toHaveLength(5);
    expect(rows[2]?.isCrashLine).toBe(true);
  });

  it('falls back to null line numbers when lineno is undefined, rather than guessing', () => {
    const rows = codeContextRows(context, undefined);
    expect(rows.every((r) => r.lineNumber === null)).toBe(true);
  });

  it('expands tabs in every row, including the crash line', () => {
    const tabbed: FrameContext = { pre: ['\tfoo();'], line: '\t\tbar();', post: ['\tbaz();'] };
    const rows = codeContextRows(tabbed, 5);
    expect(rows.map((r) => r.text)).toEqual(['  foo();', '    bar();', '  baz();']);
  });

  it('handles empty pre/post (crash line only)', () => {
    const rows = codeContextRows({ pre: [], line: 'x();', post: [] }, 1);
    expect(rows).toEqual([{ key: 'line', lineNumber: 1, text: 'x();', isCrashLine: true }]);
  });
});
