import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ISSUE_STATUS,
  ISSUE_STATUSES,
  hasNextPage,
  hasPrevPage,
  isIssueStatusFilter,
  nextOffset,
  pageRangeLabel,
  prevOffset,
} from './Project.utils.js';

describe('issue status filter (M7)', () => {
  it('defaults to open', () => {
    expect(DEFAULT_ISSUE_STATUS).toBe('open');
  });

  it('recognizes all three statuses', () => {
    expect(ISSUE_STATUSES).toEqual(['open', 'resolved', 'ignored']);
    for (const s of ISSUE_STATUSES) {
      expect(isIssueStatusFilter(s)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isIssueStatusFilter('closed')).toBe(false);
    expect(isIssueStatusFilter('')).toBe(false);
  });
});

describe('pagination math (M7)', () => {
  it('hasPrevPage is false at offset 0, true otherwise', () => {
    expect(hasPrevPage(0)).toBe(false);
    expect(hasPrevPage(25)).toBe(true);
  });

  it('hasNextPage is true only while more rows remain beyond this page', () => {
    expect(hasNextPage(0, 25, 100)).toBe(true);
    expect(hasNextPage(75, 25, 100)).toBe(false); // last full page
    expect(hasNextPage(0, 25, 10)).toBe(false); // one short page total
  });

  it('prevOffset steps back a page and floors at 0', () => {
    expect(prevOffset(50, 25)).toBe(25);
    expect(prevOffset(10, 25)).toBe(0);
  });

  it('nextOffset steps forward only if a next page exists', () => {
    expect(nextOffset(0, 25, 100)).toBe(25);
    expect(nextOffset(75, 25, 100)).toBe(75); // already at the last page — stays put
  });

  it('pageRangeLabel formats a human range', () => {
    expect(pageRangeLabel(0, 25, 142)).toBe('1–25 of 142');
    expect(pageRangeLabel(100, 25, 142)).toBe('101–125 of 142');
    expect(pageRangeLabel(0, 0, 0)).toBe('0 of 0');
  });
});
