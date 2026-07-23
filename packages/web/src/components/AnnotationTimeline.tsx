// v0.8 CONTRACT (SPEC §23 annotations): the issue detail page's investigation-log timeline —
// GET /api/issues/:id/annotations?limit=&offset= (newest first) plus a form to add one (POST
// { body, kind?, author? }). Server agent work landing concurrently, may 404 until it does:
// retry:false so an absent endpoint fails fast, and isError just means "hide the whole section"
// — same degrade-gracefully pattern as MonitorsSection.tsx / UsageSection.tsx.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';

import { api, type IssueAnnotation } from '../api.js';
import { relativeTime } from '../format.js';
import {
  ADDABLE_ANNOTATION_KINDS,
  ANNOTATIONS_PAGE_SIZE,
  ANNOTATION_BODY_MAX_LENGTH,
  type AddableAnnotationKind,
  hasNextAnnotationsPage,
  hasPrevAnnotationsPage,
  kindBadgeStyle,
} from './AnnotationTimeline.utils.js';

const KindBadge = ({ kind }: { kind: IssueAnnotation['kind'] }) => {
  const style = kindBadgeStyle(kind);
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${style.className}`}
    >
      {style.label}
    </span>
  );
};

const AnnotationRow = ({ annotation }: { annotation: IssueAnnotation }) => (
  <div className="px-3 py-2">
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      <KindBadge kind={annotation.kind} />
      <span className="text-zinc-400">{annotation.author}</span>
      <span>{relativeTime(annotation.createdAt)}</span>
    </div>
    {/* Bodies may contain code or multi-line agent notes — whitespace-preserved, never reflowed. */}
    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-zinc-300">
      {annotation.body}
    </pre>
  </div>
);

export const AnnotationTimeline = ({ issueId }: { issueId: string }) => {
  const qc = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AddableAnnotationKind>('note');

  const annotationsQ = useQuery({
    queryKey: ['issue-annotations', issueId, offset],
    queryFn: () => api.listIssueAnnotations(issueId, { limit: ANNOTATIONS_PAGE_SIZE, offset }),
    retry: false,
  });

  const addM = useMutation({
    mutationFn: () =>
      // Dashboard use defaults the author to 'human' (SPEC §23) — the agent-side callers of this
      // same endpoint default to 'agent' server-side; this form always speaks for a person.
      api.addIssueAnnotation(issueId, { body: body.trim(), kind, author: 'human' }),
    onSuccess: () => {
      setBody('');
      setKind('note');
      setOffset(0);
      void qc.invalidateQueries({ queryKey: ['issue-annotations', issueId] });
    },
  });

  // v0.8 CONTRACT — server agent work landing concurrently, may 404 until it does. Distinct from
  // "zero annotations yet" (a legitimate, common state) below: an error here means the endpoint
  // isn't there at all, so the whole section (including its heading and the add form) stays
  // hidden rather than showing a broken/empty widget.
  if (annotationsQ.isError) return null;

  const annotations = annotationsQ.data?.annotations ?? [];
  const total = annotationsQ.data?.total ?? 0;

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (!body.trim() || addM.isPending) return;
    addM.mutate();
  };

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">
        Annotations{annotationsQ.data ? ` (${String(total)})` : ''}
      </h2>

      {annotationsQ.isLoading && <div className="text-sm text-zinc-500">Loading annotations…</div>}

      {annotationsQ.data && annotations.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-6 text-center text-zinc-500 text-sm">
          No annotations yet.
        </div>
      )}

      {annotations.length > 0 && (
        <div className="rounded border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
          {annotations.map((a) => (
            <AnnotationRow key={a.id} annotation={a} />
          ))}
        </div>
      )}

      {annotationsQ.data && total > ANNOTATIONS_PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-zinc-500 mt-2">
          <span>
            {offset + 1}–{Math.min(offset + ANNOTATIONS_PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrevAnnotationsPage(offset)}
              onClick={() => {
                setOffset((o) => Math.max(0, o - ANNOTATIONS_PAGE_SIZE));
              }}
              className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={!hasNextAnnotationsPage(offset, ANNOTATIONS_PAGE_SIZE, total)}
              onClick={() => {
                setOffset((o) => o + ANNOTATIONS_PAGE_SIZE);
              }}
              className="rounded border border-zinc-700 px-2 py-1 hover:border-zinc-500 disabled:opacity-40 disabled:hover:border-zinc-700"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-3 space-y-2 rounded border border-zinc-800 p-3">
        <textarea
          aria-label="Annotation body"
          value={body}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            setBody(e.target.value);
          }}
          maxLength={ANNOTATION_BODY_MAX_LENGTH}
          rows={3}
          placeholder="Add a note…"
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 focus:outline-none focus:border-amber-500"
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            Kind
            <select
              aria-label="Annotation kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as AddableAnnotationKind);
              }}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
            >
              {ADDABLE_ANNOTATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindBadgeStyle(k).label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={!body.trim() || addM.isPending}
            className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {addM.isPending ? 'Adding…' : 'Add annotation'}
          </button>
          {addM.isError && <span className="text-xs text-red-400">{addM.error.message}</span>}
        </div>
      </form>
    </section>
  );
};
