import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';

import { api, type Breadcrumb, type Issue as IssueT } from '../api.js';

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

const renderFrame = (frame: StackFrame, idx: number) => {
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
  const payload = latestEvent ? parsePayload(latestEvent.payload) : ({} as Payload);
  const stack = payload.exception?.stacktrace ?? [];

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
            <h1 className="text-xl font-semibold break-words">{issue.title}</h1>
            <div className="font-mono text-xs text-zinc-500 mt-1 break-all">
              {issue.fingerprint}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {(['open', 'resolved', 'ignored'] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                  statusM.mutate(s);
                }}
                disabled={statusM.isPending || issue.status === s}
                className={`text-xs px-2 py-1 rounded border ${
                  issue.status === s
                    ? 'border-amber-500 text-amber-400'
                    : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
                } disabled:opacity-50`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 text-xs text-zinc-500 flex gap-4">
          <span>events: {issue.eventCount}</span>
          <span>first: {new Date(issue.firstSeen).toLocaleString()}</span>
          <span>last: {new Date(issue.lastSeen).toLocaleString()}</span>
          {payload.exception?.mechanism && <span>mechanism: {payload.exception.mechanism}</span>}
          {payload.release?.version && (
            <span>
              release: {payload.release.version}
              {payload.release.build ? ` (${payload.release.build})` : ''}
            </span>
          )}
        </div>
      </div>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Stack</h2>
        {stack.length === 0 ? (
          <div className="text-sm text-zinc-500">No stack frames.</div>
        ) : (
          <div className="rounded border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
            {stack.map(renderFrame)}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">
          Breadcrumbs ({breadcrumbs.length})
        </h2>
        {breadcrumbs.length === 0 ? (
          <div className="text-sm text-zinc-500">None.</div>
        ) : (
          <div className="rounded border border-zinc-800 overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {breadcrumbs.map((b: Breadcrumb) => (
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

      {payload.context && Object.keys(payload.context).length > 0 && (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Context</h2>
          <pre className="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs overflow-x-auto">
            {JSON.stringify(payload.context, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
};
