import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { api, type Breadcrumb, type Issue as IssueT, type ResolvedFrame } from '../api.js';
import { PlatformBadge } from '../components/PlatformBadge.js';
import { RegressedBadge } from '../components/RegressedBadge.js';
import { Sparkline } from '../components/Sparkline.js';
import {
  hasSymbolIssue,
  resolvedPlatform,
  statusLabel,
  statusToggleOptions,
} from './Issue.utils.js';

const EVENTS_PAGE_SIZE = 5;

type StackFrame = {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  inApp: boolean;
};

type Payload = {
  exception?: { stacktrace?: StackFrame[]; mechanism?: string; type?: string; value?: string };
  release?: { version?: string; build?: string };
  user?: { id?: string; email?: string };
  context?: Record<string, unknown>;
};

const parsePayload = (raw: string): Payload => {
  try {
    return JSON.parse(raw) as Payload;
  } catch {
    return {};
  }
};

const renderSymbolicatedFrame = (rawFrame: StackFrame, resolved: ResolvedFrame, idx: number) => {
  const isOk = resolved.status === 'ok';
  const fn = isOk ? (resolved.function ?? rawFrame.function ?? '?') : (rawFrame.function ?? '?');
  const location = isOk
    ? (resolved.filename ?? resolved.module ?? rawFrame.filename ?? rawFrame.module ?? '?')
    : (rawFrame.filename ?? rawFrame.module ?? '?');
  const line = isOk ? resolved.lineno : rawFrame.lineno;
  const pos = line !== undefined ? `:${String(line)}` : '';
  // Any non-'ok' status gets a badge, worded from its own status string (forward-compatible
  // with new statuses the server might add — see hasSymbolIssue in Issue.utils.ts).
  const badge = isOk ? '' : `[${statusLabel(resolved.status)}]`;

  return (
    <div
      key={idx}
      className={`px-3 py-1.5 font-mono text-xs border-l-2 ${
        rawFrame.inApp ? 'border-amber-500 bg-zinc-900' : 'border-transparent text-zinc-500'
      }`}
    >
      <span className="text-zinc-300">{fn}</span>
      <span className="text-zinc-500"> at </span>
      <span className="text-zinc-400">
        {location}
        {pos}
      </span>
      {badge && <span className="ml-2 text-zinc-600 text-xs">{badge}</span>}
    </div>
  );
};

const renderRawFrame = (frame: StackFrame, idx: number) => {
  const where = frame.function ?? '?';
  const where2 = frame.module ?? frame.filename ?? '?';
  const pos = frame.lineno
    ? `:${String(frame.lineno)}${frame.colno ? `:${String(frame.colno)}` : ''}`
    : '';
  return (
    <div
      key={idx}
      className={`px-3 py-1.5 font-mono text-xs border-l-2 ${
        frame.inApp ? 'border-amber-500 bg-zinc-900' : 'border-transparent text-zinc-500'
      }`}
    >
      <span className="text-zinc-300">{where}</span>
      <span className="text-zinc-500"> at </span>
      <span className="text-zinc-400">
        {where2}
        {pos}
      </span>
    </div>
  );
};

export const Issue = () => {
  const { issueId } = useParams({ from: '/issues/$issueId' });
  const qc = useQueryClient();
  const issueQ = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => api.getIssue(issueId),
  });

  // M-extra: SPEC §2 "list of events for the issue". Selecting an event from that list shows
  // its details here; null means "show the latest event" (the pre-existing default view).
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventsPage, setEventsPage] = useState(1);

  // Reset event selection/pagination when navigating to a different issue.
  useEffect(() => {
    setSelectedEventId(null);
    setEventsPage(1);
  }, [issueId]);

  const latestEventId = issueQ.data?.latestEvent?.id ?? null;
  const activeEventId = selectedEventId ?? latestEventId;
  const isViewingLatest = activeEventId !== null && activeEventId === latestEventId;

  const eventQ = useQuery({
    queryKey: ['event', activeEventId, 'symbolicated'],
    queryFn: () => api.getEvent(activeEventId!, { symbolicate: true }),
    enabled: activeEventId !== null,
  });

  const eventsListQ = useQuery({
    queryKey: ['issue-events', issueId, eventsPage],
    queryFn: () => api.listIssueEvents(issueId, { page: eventsPage, limit: EVENTS_PAGE_SIZE }),
  });

  // v0.3 CONTRACT C: server agent work landing concurrently, may 404 until it does.
  // retry: false so an absent endpoint fails fast instead of retrying a guaranteed-404 —
  // isError then just means "hide the sparkline" (see render below).
  const statsQ = useQuery({
    queryKey: ['issue-stats', issueId],
    queryFn: () => api.getIssueStats(issueId, 14),
    retry: false,
  });

  const statusM = useMutation({
    mutationFn: (status: IssueT['status']) => api.setIssueStatus(issueId, status),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['issue', issueId] });
      void qc.invalidateQueries({ queryKey: ['issues'] });
    },
  });

  if (issueQ.isLoading) return <div className="text-zinc-500 text-sm">Loading…</div>;
  if (issueQ.isError || !issueQ.data)
    return <div className="text-red-400 text-sm">Failed to load issue.</div>;

  const { issue, latestEvent, breadcrumbs } = issueQ.data;

  // Prefer the freshly-fetched (symbolicated) event for whichever event is active. While that
  // fetch is in flight/failed and we're still looking at the latest event, fall back to the
  // raw payload the issue detail call already gave us, so the page isn't blank on first paint.
  const activePayload = eventQ.data
    ? parsePayload(eventQ.data.event.payload)
    : isViewingLatest && latestEvent
      ? parsePayload(latestEvent.payload)
      : ({} as Payload);
  const activeBreadcrumbs = eventQ.data
    ? eventQ.data.breadcrumbs
    : isViewingLatest
      ? breadcrumbs
      : [];
  const rawStack = activePayload.exception?.stacktrace ?? [];
  const resolvedFrames = eventQ.data?.frames;
  const symbolIssue = hasSymbolIssue(resolvedFrames);
  const eventsTotalPages = eventsListQ.data
    ? Math.max(1, Math.ceil(eventsListQ.data.total / EVENTS_PAGE_SIZE))
    : 1;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <Link
          to="/projects/$projectId"
          params={{ projectId: issue.projectId }}
          className="text-sm text-zinc-500 hover:text-zinc-300"
        >
          ← Issues
        </Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-semibold break-words">{issue.title}</h1>
              {issue.status === 'regressed' && <RegressedBadge />}
              <PlatformBadge platform={resolvedPlatform(issue, latestEvent)} />
            </div>
            <div className="font-mono text-xs text-zinc-500 mt-1 break-all">
              {issue.fingerprint}
            </div>
            {statsQ.data && (
              <div className="mt-2">
                <Sparkline
                  points={statsQ.data.days}
                  width={80}
                  height={20}
                  srLabel="Issue events"
                />
              </div>
            )}
          </div>
          <div className="flex gap-2 shrink-0">
            {statusToggleOptions(issue.status).map(({ value, label }) => (
              <button
                key={value}
                onClick={() => {
                  statusM.mutate(value);
                }}
                disabled={statusM.isPending || issue.status === value}
                className={`text-xs px-2 py-1 rounded border ${
                  issue.status === value
                    ? 'border-amber-500 text-amber-400'
                    : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                } disabled:opacity-50`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 text-xs text-zinc-500 flex gap-4">
          <span>events: {issue.eventCount}</span>
          <span>first: {new Date(issue.firstSeen).toLocaleString()}</span>
          <span>last: {new Date(issue.lastSeen).toLocaleString()}</span>
          {activePayload.exception?.mechanism && (
            <span>mechanism: {activePayload.exception.mechanism}</span>
          )}
          {activePayload.release?.version && (
            <span>
              release: {activePayload.release.version}
              {activePayload.release.build ? ` (${activePayload.release.build})` : ''}
            </span>
          )}
        </div>
      </div>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm uppercase tracking-wide text-zinc-500">
            Events{eventsListQ.data ? ` (${String(eventsListQ.data.total)})` : ''}
          </h2>
          {!isViewingLatest && (
            <button
              type="button"
              onClick={() => {
                setSelectedEventId(null);
              }}
              className="text-xs text-amber-400 hover:text-amber-300 underline"
            >
              Back to latest
            </button>
          )}
        </div>

        {eventsListQ.isLoading && <div className="text-sm text-zinc-500">Loading events…</div>}
        {eventsListQ.isError && (
          <div className="text-sm text-red-400">Failed to load the event list.</div>
        )}

        {eventsListQ.data && eventsListQ.data.events.length > 0 && (
          <div className="rounded border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
            {eventsListQ.data.events.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setSelectedEventId(e.id === latestEventId ? null : e.id);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs font-mono flex items-center justify-between gap-2 ${
                  activeEventId === e.id
                    ? 'bg-amber-950 text-amber-300'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <span>{new Date(e.receivedAt).toLocaleString()}</span>
                <span className="text-zinc-500">{e.level}</span>
              </button>
            ))}
          </div>
        )}

        {eventsListQ.data && eventsListQ.data.events.length > 0 && (
          <div className="flex items-center justify-between text-xs text-zinc-500 mt-2">
            <span>
              page {eventsPage} of {eventsTotalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={eventsPage <= 1}
                onClick={() => {
                  setEventsPage((p) => Math.max(1, p - 1));
                }}
                className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={eventsPage >= eventsTotalPages}
                onClick={() => {
                  setEventsPage((p) => p + 1);
                }}
                className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {symbolIssue && (
        <div className="rounded border border-amber-700 bg-amber-950 px-4 py-3 text-xs text-amber-300">
          Some stack frames for this event aren&apos;t fully symbolicated. Upload symbols for this
          release, or check that the uploaded mapping/source map matches this build.{' '}
          <Link
            to="/projects/$projectId/releases"
            params={{ projectId: issue.projectId }}
            className="underline hover:text-amber-100"
          >
            Go to releases →
          </Link>
        </div>
      )}

      {eventQ.isError && (
        <div className="rounded border border-red-800 bg-red-950 px-4 py-3 text-xs text-red-300">
          Couldn&apos;t load the symbolicated stack for this event — showing raw frames below.
        </div>
      )}

      <section>
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Stack</h2>
        {rawStack.length === 0 ? (
          <div className="text-sm text-zinc-500">No stack frames.</div>
        ) : (
          <div className="rounded border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
            {rawStack.map((frame, idx) => {
              const resolved = resolvedFrames?.[idx];
              return resolved
                ? renderSymbolicatedFrame(frame, resolved, idx)
                : renderRawFrame(frame, idx);
            })}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">
          Breadcrumbs ({activeBreadcrumbs.length})
        </h2>
        {activeBreadcrumbs.length === 0 ? (
          <div className="text-sm text-zinc-500">None.</div>
        ) : (
          <div className="rounded border border-zinc-800 overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {activeBreadcrumbs.map((b: Breadcrumb) => (
                  <tr key={b.idx} className="border-t border-zinc-800 first:border-t-0">
                    <td className="px-3 py-1.5 text-zinc-500 font-mono w-40">
                      {new Date(b.ts).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400 w-32">{b.category}</td>
                    <td className="px-3 py-1.5">{b.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {activePayload.context && Object.keys(activePayload.context).length > 0 && (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Context</h2>
          <pre className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs overflow-x-auto">
            {JSON.stringify(activePayload.context, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
};
