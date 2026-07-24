// v0.9 CONTRACT (SPEC §24 issue merge): issue detail's "Merge" modal. `POST /api/issues/:id/merge`
// is JWT-only — "deliberately not agent-scoped" per the spec — and this whole dashboard is
// already JWT-gated, so no extra admin check is needed here beyond the button existing on this
// page. Lists GET /api/issues/:id/similar as click-to-SELECT targets: choosing a row only fills
// the target field, and the single Merge button is the one explicit confirmation — merge is
// irreversible (no unmerge in v0.9), so no row click may fire the POST directly. On success calls
// `onMerged(into)` so the caller (Issue.tsx) navigates to the target. A failed similar-issues
// fetch (404, older server) only hides that list — the free-id field still works, same "one query
// failing doesn't sink the whole feature" spirit as Issue.tsx's impact/fix-attempts/annotations
// queries failing independently of each other.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, type SimilarIssue } from '../api.js';
import { relativeTime } from '../format.js';
import { hasVerifiedFix, isMergeTargetValid, normalizeIssueId } from './MergeIssueModal.utils.js';

const SimilarIssueRow = ({
  similar,
  disabled,
  selected,
  onSelect,
}: {
  similar: SimilarIssue;
  disabled: boolean;
  selected: boolean;
  onSelect: (targetId: string) => void;
}) => (
  <button
    type="button"
    disabled={disabled}
    aria-pressed={selected}
    onClick={() => {
      onSelect(similar.issue.id);
    }}
    className={`w-full px-3 py-2 text-left text-xs hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent ${
      selected ? 'bg-zinc-900 ring-1 ring-inset ring-amber-500' : ''
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className="truncate font-medium text-zinc-200">{similar.issue.title}</span>
      <span className="shrink-0 text-zinc-500">{relativeTime(similar.issue.lastSeen)}</span>
    </div>
    <div className="mt-0.5 flex items-center gap-2 text-zinc-500">
      <span className="truncate">{similar.issue.projectSlug}</span>
      <span>·</span>
      <span>{similar.issue.status}</span>
      {hasVerifiedFix(similar.fixAttempts) && (
        <span className="text-emerald-400">verified fix</span>
      )}
    </div>
  </button>
);

export const MergeIssueModal = ({
  issueId,
  onClose,
  onMerged,
}: {
  issueId: string;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}) => {
  const [freeId, setFreeId] = useState('');

  // v0.9 CONTRACT — server agent work landing concurrently, may 404 until it does. retry: false
  // so an absent endpoint fails fast; unlike the section-level queries elsewhere (UsageSection.tsx
  // etc.) a failure here doesn't hide the whole modal, just the suggestions list below.
  const similarQ = useQuery({
    queryKey: ['similar-issues', issueId],
    queryFn: () => api.getSimilarIssues(issueId),
    retry: false,
  });

  const mergeM = useMutation({
    mutationFn: (into: string) => api.mergeIssue(issueId, into),
    onSuccess: (_data, into) => {
      onMerged(into);
    },
  });

  const handleMerge = (into: string): void => {
    if (mergeM.isPending) return;
    mergeM.mutate(into);
  };

  const handleFreeSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!isMergeTargetValid(freeId) || mergeM.isPending) return;
    handleMerge(normalizeIssueId(freeId));
  };

  const similar = similarQ.data?.similar ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Merge issue"
        className="w-full max-w-lg space-y-4 rounded border border-zinc-800 bg-zinc-950 p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-200">Merge issue</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Merging moves this issue&apos;s events, annotations, and fix attempts into the target and
          marks this issue &quot;merged&quot;. This cannot be undone.
        </p>

        <div>
          <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-600">Similar issues</h3>
          {similarQ.isLoading && <div className="text-xs text-zinc-500">Loading…</div>}
          {similarQ.isError && (
            <div className="text-xs text-zinc-600">
              No suggestions available — merge by issue id below instead.
            </div>
          )}
          {similarQ.data && similar.length === 0 && (
            <div className="text-xs text-zinc-600">No similar issues found.</div>
          )}
          {similar.length > 0 && (
            <div className="overflow-hidden rounded border border-zinc-800 divide-y divide-zinc-800">
              {similar.map((s) => (
                <SimilarIssueRow
                  key={s.issue.id}
                  similar={s}
                  disabled={mergeM.isPending}
                  selected={normalizeIssueId(freeId) === s.issue.id}
                  onSelect={setFreeId}
                />
              ))}
            </div>
          )}
        </div>

        <form onSubmit={handleFreeSubmit} className="space-y-2 border-t border-zinc-800 pt-3">
          <label htmlFor="merge-target-id" className="block text-xs text-zinc-500">
            Target issue id
          </label>
          <div className="flex gap-2">
            <input
              id="merge-target-id"
              type="text"
              value={freeId}
              onChange={(e) => {
                setFreeId(e.target.value);
              }}
              placeholder="issue id"
              className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
            />
            <button
              type="submit"
              disabled={!isMergeTargetValid(freeId) || mergeM.isPending}
              className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {mergeM.isPending ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </form>

        {mergeM.isError && (
          <div role="alert" className="text-xs text-red-400">
            {mergeM.error.message}
          </div>
        )}
      </div>
    </div>
  );
};
