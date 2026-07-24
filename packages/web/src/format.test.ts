import { describe, expect, it, vi } from 'vitest';

import { commitUrl, relativeTime, shortSha } from './format.js';

describe('relativeTime', () => {
  it('renders seconds for under a minute', () => {
    vi.useFakeTimers().setSystemTime(1_000_000);
    expect(relativeTime(1_000_000 - 5_000)).toBe('5s ago');
    vi.useRealTimers();
  });

  it('renders minutes for under an hour', () => {
    vi.useFakeTimers().setSystemTime(1_000_000);
    expect(relativeTime(1_000_000 - 5 * 60_000)).toBe('5m ago');
    vi.useRealTimers();
  });

  it('renders hours for under a day', () => {
    vi.useFakeTimers().setSystemTime(1_000_000);
    expect(relativeTime(1_000_000 - 3 * 3_600_000)).toBe('3h ago');
    vi.useRealTimers();
  });

  it('renders days beyond that', () => {
    vi.useFakeTimers().setSystemTime(1_000_000);
    expect(relativeTime(1_000_000 - 2 * 86_400_000)).toBe('2d ago');
    vi.useRealTimers();
  });
});

describe('shortSha', () => {
  it('truncates to the first 7 characters', () => {
    expect(shortSha('abcdef0123456789')).toBe('abcdef0');
  });

  it('passes a sha already 7 chars or shorter through unchanged', () => {
    expect(shortSha('abc')).toBe('abc');
  });
});

describe('commitUrl (SPEC §23: linked when repoUrl starts with https, else plain text)', () => {
  it('builds a commit URL for an https repoUrl', () => {
    expect(commitUrl('https://github.com/org/repo', 'abcdef0123')).toBe(
      'https://github.com/org/repo/commit/abcdef0123',
    );
  });

  it('returns null for a non-https repoUrl (e.g. an ssh/git URL)', () => {
    expect(commitUrl('git@github.com:org/repo.git', 'abcdef0')).toBeNull();
  });

  it('returns null for a null repoUrl', () => {
    expect(commitUrl(null, 'abcdef0')).toBeNull();
  });

  it('returns null for an undefined repoUrl (older server omitting the field)', () => {
    expect(commitUrl(undefined, 'abcdef0')).toBeNull();
  });
});
