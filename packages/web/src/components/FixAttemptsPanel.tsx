// v0.8 CONTRACT (SPEC §23 fix attempts): issue detail's "Fix attempts" panel — state pills, PR
// links, short commit SHAs linked to the project's repo when possible. Unlike
// AnnotationTimeline.tsx this isn't its own query: `fixAttempts` arrives already embedded in the
// issue detail response (GET /api/issues/:id), so Issue.tsx only mounts this once that field is
// present at all (see the `!== undefined` check there) — this component itself only handles the
// "we have the array" case (possibly empty), same division of responsibility as ImpactPanel.tsx.
import type { FixAttempt } from '../api.js';
import { httpHref, relativeTime } from '../format.js';
import { CommitLink } from './CommitLink.js';
import { fixAttemptStateStyle } from './FixAttemptsPanel.utils.js';

const StatePill = ({ state }: { state: FixAttempt['state'] }) => {
  const style = fixAttemptStateStyle(state);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${style.className}`}
    >
      {style.label}
    </span>
  );
};

const FixAttemptRow = ({
  attempt,
  repoUrl,
}: {
  attempt: FixAttempt;
  repoUrl: string | null | undefined;
}) => {
  // Only http(s) becomes a link: same "null means plain text" contract as CommitLink/commitUrl.
  // The server rejects other schemes at write time; a row stored before that check must not
  // render a `javascript:` href into the admin session.
  const href = httpHref(attempt.prUrl);
  return (
    <div className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <StatePill state={attempt.state} />
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="max-w-xs truncate text-amber-400 underline hover:text-amber-300"
            title={attempt.prUrl}
          >
            {attempt.prUrl}
          </a>
        ) : (
          <span className="max-w-xs truncate text-zinc-400" title={attempt.prUrl}>
            {attempt.prUrl}
          </span>
        )}
        {attempt.commitSha && <CommitLink sha={attempt.commitSha} repoUrl={repoUrl} />}
      </div>
      <span className="shrink-0 text-zinc-500">{relativeTime(attempt.createdAt)}</span>
    </div>
  );
};

export const FixAttemptsPanel = ({
  fixAttempts,
  repoUrl,
}: {
  fixAttempts: FixAttempt[];
  repoUrl: string | null | undefined;
}) => (
  <section>
    <h2 className="text-sm uppercase tracking-wide text-zinc-500 mb-2">Fix attempts</h2>
    {fixAttempts.length === 0 ? (
      <div className="rounded border border-dashed border-zinc-800 p-6 text-center text-zinc-500 text-sm">
        No fix attempts yet.
      </div>
    ) : (
      <div className="rounded border border-zinc-800 overflow-hidden divide-y divide-zinc-800">
        {fixAttempts.map((fa) => (
          <FixAttemptRow key={fa.id} attempt={fa} repoUrl={repoUrl} />
        ))}
      </div>
    )}
  </section>
);
