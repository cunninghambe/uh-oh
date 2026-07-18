import { describe, expect, it } from 'vitest';

import { MAX_SYMBOL_UPLOAD_BYTES } from '../api.js';
import { formatMapCounts, oversizeError, summarizeMapCounts } from './Releases.utils.js';

describe('oversizeError (M9 client-side size pre-check)', () => {
  it('allows a file right at the cap', () => {
    expect(oversizeError(MAX_SYMBOL_UPLOAD_BYTES)).toBeNull();
  });

  it('allows a small file', () => {
    expect(oversizeError(1024)).toBeNull();
  });

  it('rejects a file one byte over the cap, with a message mentioning both sizes', () => {
    const msg = oversizeError(MAX_SYMBOL_UPLOAD_BYTES + 1);
    expect(msg).not.toBeNull();
    expect(msg).toContain('50.0MB');
  });
});

describe('summarizeMapCounts (v0.4 item 2)', () => {
  it('counts web and node maps separately', () => {
    expect(
      summarizeMapCounts([
        { platform: 'web' },
        { platform: 'web' },
        { platform: 'node' },
        { platform: 'web' },
      ]),
    ).toEqual({ web: 3, node: 1 });
  });

  it('is {0, 0} for an empty list', () => {
    expect(summarizeMapCounts([])).toEqual({ web: 0, node: 0 });
  });
});

describe('formatMapCounts (v0.4 item 2)', () => {
  it('joins both platforms with a middle dot, pluralized', () => {
    expect(formatMapCounts({ web: 12, node: 8 })).toBe('12 web maps · 8 node maps');
  });

  it('singularizes a count of exactly 1', () => {
    expect(formatMapCounts({ web: 1, node: 0 })).toBe('1 web map');
  });

  it('omits a platform with zero maps entirely (no "0 node maps")', () => {
    expect(formatMapCounts({ web: 5, node: 0 })).toBe('5 web maps');
    expect(formatMapCounts({ web: 0, node: 3 })).toBe('3 node maps');
  });

  it('is the empty string when both are zero', () => {
    expect(formatMapCounts({ web: 0, node: 0 })).toBe('');
  });
});
