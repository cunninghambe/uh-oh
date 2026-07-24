import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FixAttempt } from '../api.js';
import { FixAttemptsPanel } from './FixAttemptsPanel.js';

const baseAttempt: FixAttempt = {
  id: 'fa1',
  prUrl: 'https://github.com/org/repo/pull/42',
  commitSha: 'abcdef0123456',
  state: 'filed',
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
};

describe('FixAttemptsPanel (v0.8 CONTRACT — SPEC §23 fix attempts)', () => {
  it('shows an empty state when there are no fix attempts', () => {
    render(<FixAttemptsPanel fixAttempts={[]} repoUrl="https://github.com/org/repo" />);
    expect(screen.getByText('No fix attempts yet.')).toBeInTheDocument();
  });

  it('renders a state pill and PR link for each attempt', () => {
    render(<FixAttemptsPanel fixAttempts={[baseAttempt]} repoUrl={null} />);

    expect(screen.getByText('filed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: baseAttempt.prUrl })).toHaveAttribute(
      'href',
      baseAttempt.prUrl,
    );
  });

  it.each([
    ['filed', 'border-zinc-700'],
    ['deployed', 'border-sky-600'],
    ['verified', 'border-emerald-600'],
    ['failed', 'border-red-600'],
  ] as const)('gives the %s state a distinct pill color', (state, expectedClass) => {
    render(<FixAttemptsPanel fixAttempts={[{ ...baseAttempt, state }]} repoUrl={null} />);
    expect(screen.getByText(state)).toHaveClass(expectedClass);
  });

  it('links the short commit SHA to <repoUrl>/commit/<sha> for an https repoUrl', () => {
    render(<FixAttemptsPanel fixAttempts={[baseAttempt]} repoUrl="https://github.com/org/repo" />);

    const link = screen.getByRole('link', { name: 'abcdef0' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef0123456');
  });

  it('renders the short commit SHA as plain text for a non-https repoUrl', () => {
    render(<FixAttemptsPanel fixAttempts={[baseAttempt]} repoUrl="git@github.com:org/repo.git" />);

    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'abcdef0' })).not.toBeInTheDocument();
  });

  // Security hardening: the server now rejects a non-http(s) prUrl at write time,
  // but a row stored before that check must never become a live href.
  it('renders a non-http(s) prUrl as plain text, never as an href', () => {
    render(
      <FixAttemptsPanel
        fixAttempts={[{ ...baseAttempt, prUrl: 'javascript:alert(1)' }]}
        repoUrl={null}
      />,
    );

    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'javascript:alert(1)' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('renders no commit link/text when the attempt has no commitSha', () => {
    render(
      <FixAttemptsPanel
        fixAttempts={[{ ...baseAttempt, commitSha: null }]}
        repoUrl="https://github.com/org/repo"
      />,
    );

    expect(screen.queryByText(/^[0-9a-f]{7}$/)).not.toBeInTheDocument();
  });
});
