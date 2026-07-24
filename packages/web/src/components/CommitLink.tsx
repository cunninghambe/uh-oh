// v0.8 CONTRACT (SPEC §23 release<->commit / fix attempts): renders a 7-char short commit SHA,
// linked to `<repoUrl>/commit/<sha>` when the project's repoUrl is https, plain text otherwise.
// Shared by the Releases table (Releases.tsx) and the issue detail Fix attempts panel
// (FixAttemptsPanel.tsx) so the two never drift — see format.ts's shortSha/commitUrl for the pure
// logic this wraps.
import { commitUrl, shortSha } from '../format.js';

export const CommitLink = ({
  sha,
  repoUrl,
}: {
  sha: string;
  repoUrl: string | null | undefined;
}) => {
  const href = commitUrl(repoUrl, sha);
  const label = shortSha(sha);

  if (!href) {
    return <span className="font-mono text-xs text-zinc-400">{label}</span>;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-zinc-400 underline hover:text-zinc-200"
    >
      {label}
    </a>
  );
};
