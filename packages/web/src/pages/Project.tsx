import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { api } from '../api.js';
import {
  DEFAULT_ISSUE_STATUS,
  ISSUE_STATUSES,
  ISSUES_PAGE_SIZE,
  hasNextPage,
  hasPrevPage,
  nextOffset,
  pageRangeLabel,
  prevOffset,
  type IssueStatusFilter,
} from './Project.utils.js';

const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  const d = Math.floor(h / 24);
  return `${String(d)}d ago`;
};

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
  const [offset, setOffset] = useState(0);

  const changeStatus = (next: IssueStatusFilter): void => {
    if (next === status) return;
    setStatus(next);
    setOffset(0); // switching tabs always starts back at page 1
  };

  const issuesQ = useQuery({
    queryKey: ['issues', projectId, status, offset],
    queryFn: () => api.listIssues(projectId, { status, limit: ISSUES_PAGE_SIZE, offset }),
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

      <div className="flex gap-1 border-b border-zinc-800" role="tablist" aria-label="Issue status">
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
                      <div className="font-medium truncate">{i.title}</div>
                      <div className="text-xs text-zinc-500 font-mono truncate">
                        {i.fingerprint}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{i.eventCount}</td>
                  <td className="px-4 py-3 text-zinc-400">{relativeTime(i.lastSeen)}</td>
                  <td className="px-4 py-3">
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
    </div>
  );
};
