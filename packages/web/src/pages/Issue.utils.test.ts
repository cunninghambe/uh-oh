import { describe, expect, it } from 'vitest';

import type { ResolvedFrame } from '../api.js';
import { hasSymbolIssue, statusLabel } from './Issue.utils.js';

const frame = (status: ResolvedFrame['status']): ResolvedFrame => ({ status });

describe('hasSymbolIssue (M14)', () => {
  it('is false when frames are undefined (still loading / not fetched)', () => {
    expect(hasSymbolIssue(undefined)).toBe(false);
  });

  it('is false when every frame is ok', () => {
    expect(hasSymbolIssue([frame('ok'), frame('ok')])).toBe(false);
  });

  it('is true for a no_symbols frame mixed in with ok frames', () => {
    expect(hasSymbolIssue([frame('ok'), frame('no_symbols')])).toBe(true);
  });

  it('is true for corrupt_mapping and unsymbolicated too — not just no_symbols', () => {
    expect(hasSymbolIssue([frame('corrupt_mapping')])).toBe(true);
    expect(hasSymbolIssue([frame('unsymbolicated')])).toBe(true);
  });

  it('keys on !== "ok" so it stays correct for a status this union does not know about yet', () => {
    // The server agent may add e.g. a corrupt-sourcemap status; hasSymbolIssue must still catch
    // it without a matching code change here. Cast needed since the literal isn't (yet) in the
    // ResolvedFrame['status'] union — that's the whole point of the forward-compat test.
    const futureFrame = { status: 'corrupt_sourcemap' } as unknown as ResolvedFrame;
    expect(hasSymbolIssue([futureFrame])).toBe(true);
  });
});

describe('statusLabel', () => {
  it('gives a friendly label for known statuses', () => {
    expect(statusLabel('no_symbols')).toBe('no symbols uploaded');
    expect(statusLabel('unsymbolicated')).toBe('unsymbolicated');
    expect(statusLabel('corrupt_mapping')).toBe('corrupt mapping file');
  });

  it('falls back to the raw status string for anything unrecognized', () => {
    const futureStatus = 'corrupt_sourcemap' as ResolvedFrame['status'];
    expect(statusLabel(futureStatus)).toBe('corrupt_sourcemap');
  });
});
