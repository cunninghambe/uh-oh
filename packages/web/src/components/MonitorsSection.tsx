// v0.5 CONTRACT M: the Project page's "Monitors" section — a dead-man's-switch list. Monitors
// are never created here (the empty state and the hint line both say so); the UI only lists,
// edits (name/interval/grace), pauses/resumes, and deletes rows that already exist because
// something in the fleet has POSTed at least one check-in.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, type Monitor } from '../api.js';
import { relativeTime } from '../format.js';
import { checkInUrlPattern, statusPillStyle, toggleStatusAction } from './MonitorsSection.utils.js';

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

const MonitorRow = ({ monitor, projectId }: { monitor: Monitor; projectId: string }) => {
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries({ queryKey: ['monitors', projectId] });

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(monitor.name ?? '');
  const [intervalMinutes, setIntervalMinutes] = useState(monitor.intervalMinutes);
  const [graceMinutes, setGraceMinutes] = useState(monitor.graceMinutes);

  const statusM = useMutation({
    mutationFn: (next: 'ok' | 'paused') => api.updateMonitor(monitor.id, { status: next }),
    onSuccess: invalidate,
  });

  const editM = useMutation({
    mutationFn: () =>
      api.updateMonitor(monitor.id, {
        intervalMinutes,
        graceMinutes,
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
    setEditing(true);
  };

  const submitEdit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (editM.isPending) return;
    editM.mutate();
  };

  const toggle = toggleStatusAction(monitor.status);

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
            <StatusPill status={monitor.status} />
            {monitor.overdue && monitor.status !== 'missed' && (
              <span className="text-[10px] uppercase tracking-wide text-red-400">overdue</span>
            )}
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            every {monitor.intervalMinutes}m, grace {monitor.graceMinutes}m · last check-in:{' '}
            {monitor.lastCheckInAt ? relativeTime(monitor.lastCheckInAt) : 'never'}
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
  const monitorsQ = useQuery({
    queryKey: ['monitors', projectId],
    queryFn: () => api.listMonitors(projectId),
    retry: false,
  });

  // v0.5 CONTRACT M — server agent work landing concurrently, may 404 until it does. Distinct
  // from "zero monitors yet" (a legitimate, common state) below: an error here means the
  // endpoint isn't there at all, so the whole section (including its heading) stays hidden
  // rather than showing a broken/empty widget.
  if (monitorsQ.isError) return null;

  const monitors = monitorsQ.data?.monitors ?? [];

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Monitors</h2>
      <p className="mb-2 text-xs text-zinc-600">
        Created automatically by a project&apos;s first check-in — there&apos;s no &quot;add&quot;
        button here.
      </p>

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
