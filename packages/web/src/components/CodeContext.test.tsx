import { getDefaultNormalizer, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FrameContext } from '../api.js';
import { CodeContext } from './CodeContext.js';

const context: FrameContext = {
  pre: ['function f() {', '  const a = 1;'],
  line: '  throw new Error("boom");',
  post: ['  return a;', '}'],
};

// getByText's default normalizer trims/collapses whitespace, which would swallow exactly the
// leading indentation this feature is about preserving — so these assertions need an
// identity normalizer to check the rendered text byte-for-byte.
const exactText = (text: string) =>
  screen.getByText(text, {
    normalizer: getDefaultNormalizer({ trim: false, collapseWhitespace: false }),
  });

describe('CodeContext', () => {
  it('renders a collapsed <details> with a "Source" toggle', () => {
    render(<CodeContext context={context} lineno={10} />);
    const details = screen.getByText('Source').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
  });

  it('renders every pre/line/post line, preserving leading indentation', () => {
    render(<CodeContext context={context} lineno={10} />);
    expect(exactText('function f() {')).toBeInTheDocument();
    expect(exactText('  const a = 1;')).toBeInTheDocument();
    expect(exactText('  throw new Error("boom");')).toBeInTheDocument();
    expect(exactText('  return a;')).toBeInTheDocument();
    expect(exactText('}')).toBeInTheDocument();
  });

  it('shows the resolved line numbers in the gutter', () => {
    render(<CodeContext context={context} lineno={10} />);
    // pre[0]=8, pre[1]=9, crash=10, post[0]=11, post[1]=12
    for (const n of [8, 9, 10, 11, 12]) {
      expect(screen.getByText(String(n))).toBeInTheDocument();
    }
  });

  it('highlights only the crash line row', () => {
    render(<CodeContext context={context} lineno={10} />);
    const crashRow = exactText('  throw new Error("boom");').closest('tr');
    expect(crashRow).toHaveClass('bg-amber-950/50');
    const preRow = exactText('function f() {').closest('tr');
    expect(preRow).not.toHaveClass('bg-amber-950/50');
  });

  it('expands tabs to two spaces so indentation renders consistently', () => {
    render(<CodeContext context={{ pre: ['\tfoo();'], line: 'bar();', post: [] }} lineno={2} />);
    expect(exactText('  foo();')).toBeInTheDocument();
  });

  it('keeps long lines on one line (no wrap) via whitespace-pre', () => {
    const longLine = 'x'.repeat(300);
    render(<CodeContext context={{ pre: [], line: longLine, post: [] }} lineno={1} />);
    expect(screen.getByText(longLine)).toHaveClass('whitespace-pre');
  });
});
