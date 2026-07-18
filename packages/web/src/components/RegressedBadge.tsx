// v0.3 CONTRACT B: a clearly-visible badge for issues the server has moved back to 'regressed'
// (a resolved issue recurred). Used in the issues list rows and the issue detail header.

export const RegressedBadge = () => (
  <span className="inline-flex items-center rounded-full border border-red-600 bg-red-950 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-300">
    Regressed
  </span>
);
