// Small formatting helpers shared across pages/components. Split out (v0.5) so both Project.tsx
// (issue "last seen") and MonitorsSection.tsx (monitor "last check-in") share one implementation
// instead of two copies drifting apart.

/** Human-relative time like "3s ago" / "5m ago" / "2h ago" / "1d ago". */
export const relativeTime = (ms: number): string => {
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

// v0.8 CONTRACT (SPEC §23 release<->commit / fix attempts): shared by Releases.tsx and
// FixAttemptsPanel.tsx (via CommitLink.tsx) — "short (7-char) commit SHAs linked to
// <repoUrl>/commit/<sha> when the project's repoUrl starts with https (plain text otherwise)".

/** First 7 characters of a commit SHA — the short form shown throughout the dashboard. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * Builds a commit URL from a project's repoUrl + a commit SHA, or null when the repo URL isn't
 * usable as a link base (missing/null, or not https — e.g. an ssh/git URL). Callers render plain
 * text instead of a link when this returns null.
 */
export const commitUrl = (repoUrl: string | null | undefined, sha: string): string | null =>
  repoUrl && repoUrl.startsWith('https://') ? `${repoUrl}/commit/${sha}` : null;
