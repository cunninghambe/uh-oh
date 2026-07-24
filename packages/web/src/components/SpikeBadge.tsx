// v0.8 CONTRACT (SPEC §23 spike detection): a clearly-visible badge for issues the 5-min spike
// sweep currently has flagged (issue.spikeActive). Used in the issues list rows and the issue
// detail header, styled like RegressedBadge.tsx but in a distinct color (orange, not yet used
// elsewhere in the palette) so the two states are never confused at a glance.

export const SpikeBadge = () => (
  <span className="inline-flex items-center rounded-full border border-orange-600 bg-orange-950 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange-300">
    Spike
  </span>
);
