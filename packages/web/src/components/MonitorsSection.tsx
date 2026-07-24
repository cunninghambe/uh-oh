// v0.5 CONTRACT M: the Project page's "Monitors" section — a dead-man's-switch list for the
// 'checkin' kind (never created here; the hint line explains it's the fleet's first check-in
// that creates a row). v0.9 CONTRACT (SPEC §24 uptime probes) adds the 'http' kind, which *is*
// created from this section (the "+ Add HTTP monitor" form below) since nothing external pings
// it into existence. Both kinds share list/edit/pause-resume/delete; `kind` itself is immutable
// after create, so the edit form never renders a way to change it (see MonitorRow.editing below).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, type Monitor } from '../api.js';
import { relativeTime } from '../format.js';
import {
  DEFAULT_HTTP_INTERVAL_MINUTES,
  DEFAULT_HTTP_TIMEOUT_MS,
  MAX_HTTP_TIMEOUT_MS,
  MONITOR_SLUG_PATTERN,
  checkInUrlPattern,
  httpProbeSummary,
  monitorKind,
  statusPillStyle,
  toggleStatusAction,
} from './MonitorsSection.utils.js';

const StatusPill = ({ status }: { status: Monitor['status'] }) => {
  const style = statusPillStyle(status);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${style.className}`}
    >
      {style.label}
    </span>
  );
};

const KindBadge = ({ kind }: { kind: 'checkin' | 'http' }) => {
  if (kind !== 'http') return null;
  return (
    <span className="inline-flex items-center rounded border border-cyan-700 bg-cyan-950 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-cyan-300">
      HTTP
    </span>
  );
};

const MonitorRow = ({ monitor, projectId }: { monitor: Monitor; projectId: string }) => {
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries({ queryKey: ['monitors', projectId] });

  const kind = monitorKind(monitor);
  const isHttp = kind === 'http';

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(monitor.name ?? '');
  const [intervalMinutes, setIntervalMinutes] = useState(monitor.intervalMinutes);
  const [graceMinutes, setGraceMinutes] = useState(monitor.graceMinutes);
  const [url, setUrl] = useState(monitor.url ?? '');
  const [timeoutMs, setTimeoutMs] = useState(monitor.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

  const statusM = useMutation({
    mutationFn: (next: 'ok' | 'paused') => api.updateMonitor(monitor.id, { status: next }),
    onSuccess: invalidate,
  });

  const editM = useMutation({
    mutationFn: () =>
      api.updateMonitor(monitor.id, {
        intervalMinutes,
        // v0.9 CONTRACT (SPEC §24 uptime probes): kind is never a PATCH field (immutable after
        // create) — an http row edits url/timeoutMs instead of the checkin-only graceMinutes.
        ...(isHttp ? { url: url.trim(), timeoutMs } : { graceMinutes }),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: () => {
      invalidate();
      setEditing(false);
    },
  });

  const deleteM = useMutation({
    mutationFn: () => api.deleteMonitor(monitor.id),
    onSuccess: invalidate,
  });

  const startEdit = (): void => {
    setName(monitor.name ?? '');
    setIntervalMinutes(monitor.intervalMinutes);
    setGraceMinutes(monitor.graceMinutes);
    setUrl(monitor.url ?? '');
    setTimeoutMs(monitor.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
    setEditing(true);
  };

  const submitEdit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (editM.isPending) return;
    editM.mutate();
  };

  const toggle = toggleStatusAction(monitor.status);
  const probe = httpProbeSummary(monitor);

  if (editing) {
    return (
      <form
        onSubmit={submitEdit}
        className="border-t border-zinc-800 px-4 py-3 space-y-2 first:border-t-0"
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-zinc-500">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder={monitor.slug}
              maxLength={128}
              className="w-36 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-500">
            Interval (min)
            <input
              type="number"
              min={1}
              value={intervalMinutes}
              onChange={(e) => {
                setIntervalMinutes(Math.max(1, parseInt(e.target.value, 10) || 1));
              }}
              className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
            />
          </label>
          {/* v0.9 CONTRACT (SPEC §24 uptime probes): kind is immutable, so this branch is purely
              which OTHER fields apply to this row's kind — never a kind selector. */}
          {isHttp ? (
            <>
              <label className="flex items-center gap-1 text-zinc-500">
                URL
                <input
                  type="url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                  }}
                  className="w-56 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
                />
              </label>
              <label className="flex items-center gap-1 text-zinc-500">
                Timeout (ms)
                <input
                  type="number"
                  min={1}
                  max={MAX_HTTP_TIMEOUT_MS}
                  value={timeoutMs}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10) || DEFAULT_HTTP_TIMEOUT_MS;
                    setTimeoutMs(Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(1, parsed)));
                  }}
                  className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
                />
              </label>
            </>
          ) : (
            <label className="flex items-center gap-1 text-zinc-500">
              Grace (min)
              <input
                type="number"
                min={0}
                value={graceMinutes}
                onChange={(e) => {
                  setGraceMinutes(Math.max(0, parseInt(e.target.value, 10) || 0));
                }}
                className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
              />
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={editM.isPending}
            className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {editM.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
            }}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          {editM.isError && <span className="text-xs text-red-400">{editM.error.message}</span>}
        </div>
      </form>
    );
  }

  return (
    <div className="border-t border-zinc-800 px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-zinc-200 truncate">{monitor.slug}</span>
            {monitor.name && <span className="text-xs text-zinc-500 truncate">{monitor.name}</span>}
            <KindBadge kind={kind} />
            <StatusPill status={monitor.status} />
            {monitor.overdue && monitor.status !== 'missed' && (
              <span className="text-[10px] uppercase tracking-wide text-red-400">overdue</span>
            )}
          </div>
          {/* v0.9 CONTRACT (SPEC §24 uptime probes brief: "http rows show the URL... alongside
              the existing status pills"). */}
          {isHttp && monitor.url && (
            <div className="mt-0.5 truncate font-mono text-xs text-zinc-500">{monitor.url}</div>
          )}
          <div className="mt-1 text-xs text-zinc-500">
            {isHttp ? (
              <>
                every {monitor.intervalMinutes}m · last probe: {probe.status}
                {monitor.lastProbeAt ? ` (${relativeTime(monitor.lastProbeAt)})` : ''}
              </>
            ) : (
              <>
                every {monitor.intervalMinutes}m, grace {monitor.graceMinutes}m · last check-in:{' '}
                {monitor.lastCheckInAt ? relativeTime(monitor.lastCheckInAt) : 'never'}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => {
              statusM.mutate(toggle.next);
            }}
            disabled={statusM.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
          >
            {toggle.label}
          </button>
          <button
            type="button"
            onClick={startEdit}
            className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
          >
            Edit
          </button>
          {confirmingDelete ? (
            <>
              <button
                type="button"
                onClick={() => {
                  deleteM.mutate();
                }}
                disabled={deleteM.isPending}
                className="rounded bg-red-700 px-2 py-1 text-white hover:bg-red-600 disabled:opacity-50"
              >
                {deleteM.isPending ? 'Deleting…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                }}
                className="rounded border border-zinc-700 px-2 py-1 text-zinc-400 hover:text-zinc-200"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(true);
              }}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-500 hover:text-red-400 hover:border-red-800"
            >
              Delete
            </button>
          )}
        </div>
      </div>
      {deleteM.isError && <div className="mt-1 text-xs text-red-400">{deleteM.error.message}</div>}
    </div>
  );
};

export const MonitorsSection = ({
  projectId,
  publicKey,
}: {
  projectId: string;
  publicKey: string;
}) => {
  const qc = useQueryClient();

  const monitorsQ = useQuery({
    queryKey: ['monitors', projectId],
    queryFn: () => api.listMonitors(projectId),
    retry: false,
  });

  // v0.9 CONTRACT (SPEC §24 uptime probes): the http-monitor create form's state. Declared
  // unconditionally alongside monitorsQ above — every hook in this component must run every
  // render regardless of monitorsQ.isError, so the early-return guard below stays *after* every
  // hook call (react-hooks/rules-of-hooks; see layout.tsx's fix for the same class of bug).
  const [showCreate, setShowCreate] = useState(false);
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_HTTP_INTERVAL_MINUTES);
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_HTTP_TIMEOUT_MS);

  const createM = useMutation({
    mutationFn: () =>
      api.createMonitor(projectId, {
        kind: 'http',
        slug: slug.trim(),
        url: url.trim(),
        intervalMinutes,
        timeoutMs,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['monitors', projectId] });
      setShowCreate(false);
      setSlug('');
      setUrl('');
      setIntervalMinutes(DEFAULT_HTTP_INTERVAL_MINUTES);
      setTimeoutMs(DEFAULT_HTTP_TIMEOUT_MS);
    },
  });

  // v0.5 CONTRACT M — server agent work landing concurrently, may 404 until it does. Distinct
  // from "zero monitors yet" (a legitimate, common state) below: an error here means the
  // endpoint isn't there at all, so the whole section (including its heading) stays hidden
  // rather than showing a broken/empty widget.
  if (monitorsQ.isError) return null;

  const monitors = monitorsQ.data?.monitors ?? [];

  const submitCreate = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (createM.isPending) return;
    createM.mutate();
  };

  const slugValid = MONITOR_SLUG_PATTERN.test(slug.trim());

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-sm uppercase tracking-wide text-zinc-500">Monitors</h2>
        <button
          type="button"
          onClick={() => {
            setShowCreate((v) => !v);
          }}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
        >
          {showCreate ? 'Cancel' : '+ Add HTTP monitor'}
        </button>
      </div>
      <p className="mb-2 text-xs text-zinc-600">
        Created automatically by a project&apos;s first check-in. Add an HTTP monitor with the
        button above to probe a URL on a schedule instead.
      </p>

      {showCreate && (
        <form
          onSubmit={submitCreate}
          className="mb-4 space-y-2 rounded border border-zinc-800 p-3"
          aria-label="Add HTTP monitor"
        >
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label className="flex flex-col gap-1 text-zinc-500">
              Slug
              <input
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                }}
                placeholder="api-health"
                maxLength={64}
                required
                className="w-36 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-zinc-500">
              URL
              <input
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                }}
                placeholder="https://example.com/health"
                required
                className="w-56 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-zinc-500">
              Interval (min)
              <input
                type="number"
                min={1}
                value={intervalMinutes}
                onChange={(e) => {
                  setIntervalMinutes(Math.max(1, parseInt(e.target.value, 10) || 1));
                }}
                className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-zinc-500">
              Timeout (ms)
              <input
                type="number"
                min={1}
                max={MAX_HTTP_TIMEOUT_MS}
                value={timeoutMs}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10) || DEFAULT_HTTP_TIMEOUT_MS;
                  setTimeoutMs(Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(1, parsed)));
                }}
                className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-200 focus:outline-none focus:border-amber-500"
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={createM.isPending || !slug.trim() || !url.trim() || !slugValid}
              className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {createM.isPending ? 'Creating…' : 'Create'}
            </button>
            {!slugValid && slug.trim() && (
              <span className="text-xs text-zinc-600">lowercase letters, digits, hyphens only</span>
            )}
            {createM.isError && (
              <span className="text-xs text-red-400">{createM.error.message}</span>
            )}
          </div>
        </form>
      )}

      {monitorsQ.isLoading ? (
        <div className="text-sm text-zinc-500">Loading monitors…</div>
      ) : monitors.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-800 p-6 text-center text-zinc-500 text-sm space-y-2">
          <p>No monitors yet. Send a check-in to create one:</p>
          <code className="block break-all rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            {checkInUrlPattern(publicKey)}
          </code>
        </div>
      ) : (
        <div className="rounded border border-zinc-800 overflow-hidden">
          {monitors.map((m) => (
            <MonitorRow key={m.id} monitor={m} projectId={projectId} />
          ))}
        </div>
      )}
    </section>
  );
};
