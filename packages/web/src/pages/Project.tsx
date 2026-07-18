import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { api } from '../api.js';
import { MonitorsSection } from '../components/MonitorsSection.js';
import { PlatformBadge } from '../components/PlatformBadge.js';
import { RegressedBadge } from '../components/RegressedBadge.js';
import { Sparkline } from '../components/Sparkline.js';
import { relativeTime } from '../format.js';
import {
  DEFAULT_ISSUE_SORT,
  DEFAULT_ISSUE_STATUS,
  ISSUE_SORTS,
  ISSUE_SORT_LABELS,
  ISSUE_STATUSES,
  ISSUES_PAGE_SIZE,
  hasNextPage,
  hasPrevPage,
  isIssueSort,
  nextOffset,
  pageRangeLabel,
  prevOffset,
  type IssueSort,
  type IssueStatusFilter,
} from './Project.utils.js';

export const Project = () => {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const projectQ = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
  });

  // SPEC §13: resolved issues must leave the default list and be reachable under a filter;
  // default view is 'open'. `status` is always sent explicitly (never omitted) so the API
  // never falls back to its own default, which could silently diverge from ours.
  const [status, setStatus] = useState<IssueStatusFilter>(DEFAULT_ISSUE_STATUS);
  const [sort, setSort] = useState<IssueSort>(DEFAULT_ISSUE_SORT);
  const [offset, setOffset] = useState(0);

  const changeStatus = (next: IssueStatusFilter): void => {
    if (next === status) return;
    setStatus(next);
    setOffset(0); // switching tabs always starts back at page 1
  };

  const changeSort = (next: IssueSort): void => {
    if (next === sort) return;
    setSort(next);
    setOffset(0); // changing sort order always starts back at page 1
  };

  const issuesQ = useQuery({
    queryKey: ['issues', projectId, status, sort, offset],
    queryFn: () => api.listIssues(projectId, { status, sort, limit: ISSUES_PAGE_SIZE, offset }),
  });

  // v0.3 CONTRACT C: server agent work landing concurrently, may 404 until it does.
  // retry: false so an absent endpoint fails fast instead of retrying a guaranteed-404 —
  // isError then just means "hide the sparkline" (see render below).
  const statsQ = useQuery({
    queryKey: ['project-stats', projectId],
    queryFn: () => api.getProjectStats(projectId, 14),
    retry: false,
  });

  const project = projectQ.data?.projects.find((p) => p.id === projectId);
  const total = issuesQ.data?.total ?? 0;
  const count = issuesQ.data?.issues.length ?? 0;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Projects
        </Link>
        <div className="flex items-center justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-semibold">{project?.name ?? '…'}</h1>
            {project && (
              <div className="text-xs font-mono text-zinc-500 mt-1 break-all">
                DSN base: /ingest/{project.publicKey}
              </div>
            )}
            {statsQ.data && (
              <div className="mt-2 flex items-center gap-2">
                <Sparkline points={statsQ.data.days} srLabel="Events" />
                <span className="text-xs text-zinc-500">{statsQ.data.totalOpenIssues} open</span>
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            <Link
              to="/projects/$projectId/releases"
              params={{ projectId }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
            >
              Releases
            </Link>
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId }}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
            >
              Settings
            </Link>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-b border-zinc-800">
        <div className="flex gap-1" role="tablist" aria-label="Issue status">
          {ISSUE_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => {
                changeStatus(s);
              }}
              className={`px-3 py-1.5 text-xs capitalize border-b-2 -mb-px ${
                status === s
                  ? 'border-amber-500 text-amber-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-zinc-500 pb-1.5 shrink-0">
          Sort
          <select
            aria-label="Sort issues"
            value={sort}
            onChange={(e) => {
              const next = e.target.value;
              if (isIssueSort(next)) changeSort(next);
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            {ISSUE_SORTS.map((s) => (
              <option key={s} value={s}>
                {ISSUE_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {issuesQ.isLoading && <div className="text-zinc-500 text-sm">Loading issues…</div>}
      {issuesQ.isError && <div className="text-red-400 text-sm">Failed to load issues.</div>}

      {issuesQ.data && issuesQ.data.issues.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-8 text-center text-zinc-500">
          No {status} issues.
          {status === DEFAULT_ISSUE_STATUS && (
            <>
              {' '}
              Send an event to <code>/ingest/&lt;publicKey&gt;</code>.
            </>
          )}
        </div>
      )}

      {issuesQ.data && issuesQ.data.issues.length > 0 && (
        <div className="rounded border border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2">Issue</th>
                <th className="px-4 py-2 w-24 text-right">Events</th>
                <th className="px-4 py-2 w-32">Last seen</th>
                <th className="px-4 py-2 w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {issuesQ.data.issues.map((i) => (
                <tr key={i.id} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                  <td className="px-4 py-3">
                    <Link
                      to="/issues/$issueId"
                      params={{ issueId: i.id }}
                      className="hover:text-amber-300"
                    >
                      <div className="flex items-center gap-2">
                        <div className="font-medium truncate min-w-0">{i.title}</div>
                        <PlatformBadge platform={i.platform} />
                      </div>
                      <div className="text-xs text-zinc-500 font-mono truncate">
                        {i.fingerprint}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{i.eventCount}</td>
                  <td className="px-4 py-3 text-zinc-400">{relativeTime(i.lastSeen)}</td>
                  <td className="px-4 py-3">
                    {i.status === 'regressed' ? (
                      <RegressedBadge />
                    ) : (
                      <span
                        className={
                          i.status === 'open'
                            ? 'text-amber-400'
                            : i.status === 'resolved'
                              ? 'text-emerald-400'
                              : 'text-zinc-500'
                        }
                      >
                        {i.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {issuesQ.data && total > 0 && (
        <div className="flex items-center justify-between text-xs text-zinc-500">
          <span>{pageRangeLabel(offset, count, total)}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrevPage(offset)}
              onClick={() => {
                setOffset((o) => prevOffset(o, ISSUES_PAGE_SIZE));
              }}
              className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={!hasNextPage(offset, ISSUES_PAGE_SIZE, total)}
              onClick={() => {
                setOffset((o) => nextOffset(o, ISSUES_PAGE_SIZE, total));
              }}
              className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* v0.5 CONTRACT M: renders nothing itself if GET .../monitors 404s (endpoint not yet
          available on the server this build is talking to) — see MonitorsSection.tsx. */}
      {project && <MonitorsSection projectId={projectId} publicKey={project.publicKey} />}
    </div>
  );
};
