import { describe, expect, it } from 'vitest';

import { hasVerifiedFix, isMergeTargetValid, normalizeIssueId } from './MergeIssueModal.utils.js';

describe('normalizeIssueId', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeIssueId('  abc123  ')).toBe('abc123');
  });

  it('leaves an already-trimmed id unchanged', () => {
    expect(normalizeIssueId('abc123')).toBe('abc123');
  });
});

describe('isMergeTargetValid', () => {
  it('is false for an empty string', () => {
    expect(isMergeTargetValid('')).toBe(false);
  });

  it('is false for whitespace only', () => {
    expect(isMergeTargetValid('   ')).toBe(false);
  });

  it('is true for a non-empty id, even with surrounding whitespace', () => {
    expect(isMergeTargetValid('  abc123  ')).toBe(true);
  });
});

describe('hasVerifiedFix', () => {
  it('is false for an empty fix-attempts list', () => {
    expect(hasVerifiedFix([])).toBe(false);
  });

  it('is false when no attempt is verified', () => {
    expect(hasVerifiedFix([{ state: 'filed' }, { state: 'deployed' }])).toBe(false);
  });

  it('is true when at least one attempt is verified', () => {
    expect(hasVerifiedFix([{ state: 'failed' }, { state: 'verified' }])).toBe(true);
  });
});
