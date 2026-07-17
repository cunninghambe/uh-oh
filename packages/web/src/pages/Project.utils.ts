// Pure helpers for the issues list (status tabs + offset pagination), split out from
// Project.tsx so the tab/pagination math is unit-testable without rendering the component.

export const ISSUE_STATUSES = ['open', 'resolved', 'ignored'] as const;
export type IssueStatusFilter = (typeof ISSUE_STATUSES)[number];

export const DEFAULT_ISSUE_STATUS: IssueStatusFilter = 'open';
export const ISSUES_PAGE_SIZE = 25;

export const isIssueStatusFilter = (value: string): value is IssueStatusFilter =>
  (ISSUE_STATUSES as readonly string[]).includes(value);

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
