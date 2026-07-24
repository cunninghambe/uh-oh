// v0.9 CONTRACT (SPEC §24 issue merge): a clearly-visible badge for a source issue that has been
// merged into another (status 'merged'). Styled like RegressedBadge.tsx/SpikeBadge.tsx but in
// violet — the one accent color not already claimed by another status/state badge in the palette
// (red=regressed/missed/failed, orange=spike, emerald=ok/verified, sky=deployed).

export const MergedBadge = () => (
  <span className="inline-flex items-center rounded-full border border-violet-600 bg-violet-950 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">
    Merged
  </span>
);
