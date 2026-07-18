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
