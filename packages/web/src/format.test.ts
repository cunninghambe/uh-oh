import { describe, expect, it, vi } from 'vitest';

import { relativeTime } from './format.js';

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
