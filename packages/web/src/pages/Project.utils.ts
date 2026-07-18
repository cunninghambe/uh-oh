// Pure helpers for the issues list (status tabs + offset pagination + sort), split out from
// Project.tsx so the tab/pagination/sort math is unit-testable without rendering the component.

// Order matters here — it drives the left-to-right tab order in Project.tsx. 'regressed' is
// v0.3 CONTRACT B (system-set, not user-settable) and sits right after 'open' so a regression
// is hard to miss. Default tab is unchanged ('open').
export const ISSUE_STATUSES = ['open', 'regressed', 'resolved', 'ignored'] as const;
export type IssueStatusFilter = (typeof ISSUE_STATUSES)[number];

export const DEFAULT_ISSUE_STATUS: IssueStatusFilter = 'open';
export const ISSUES_PAGE_SIZE = 25;

export const isIssueStatusFilter = (value: string): value is IssueStatusFilter =>
  (ISSUE_STATUSES as readonly string[]).includes(value);

// v0.3 item 1: sort control. Server support for `sort` on GET .../issues is pre-existing
// (SPEC §9), not part of the concurrent CONTRACT work.
export const ISSUE_SORTS = ['lastSeen', 'eventCount', 'firstSeen'] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

export const DEFAULT_ISSUE_SORT: IssueSort = 'lastSeen';

export const isIssueSort = (value: string): value is IssueSort =>
  (ISSUE_SORTS as readonly string[]).includes(value);

export const ISSUE_SORT_LABELS: Record<IssueSort, string> = {
  lastSeen: 'Last seen',
  eventCount: 'Event count',
  firstSeen: 'First seen',
};

export const hasPrevPage = (offset: number): boolean => offset > 0;

export const hasNextPage = (offset: number, limit: number, total: number): boolean =>
  offset + limit < total;

export const prevOffset = (offset: number, limit: number): number => Math.max(0, offset - limit);

export const nextOffset = (offset: number, limit: number, total: number): number =>
  hasNextPage(offset, limit, total) ? offset + limit : offset;

/** Human label like "1–25 of 142", or "0 of 0" for an empty page. */
export const pageRangeLabel = (offset: number, count: number, total: number): string => {
  if (total <= 0 || count <= 0) return '0 of 0';
  const start = offset + 1;
  const end = offset + count;
  return `${String(start)}–${String(end)} of ${String(total)}`;
};
