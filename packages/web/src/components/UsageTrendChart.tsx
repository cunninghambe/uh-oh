// v0.6 CONTRACT U-API: the Usage section's 30-day dual-series inline SVG trend chart — pageviews
// as the primary line/area, visitors as a second line (hand-rolled, no charting dependency, per
// the brief). Reuses Sparkline.utils.ts's `multiSeriesPoints` (v0.6 addition to that file) so
// both series share one y-scale instead of each being independently normalized, which would make
// a quiet visitors line look as tall as a busy pageviews line.
//
// Zero-data (every value 0) automatically renders as a flat baseline near the bottom — that's
// `multiSeriesPoints`/`fitToRange`'s existing flat-range behavior, not special-cased here; see
// UsageSection.tsx for the accompanying hint text shown alongside it.
import { multiSeriesPoints } from './Sparkline.utils.js';

export type UsageTrendDay = { date: string; pageviews: number; visitors: number };

export const UsageTrendChart = ({
  days,
  totals,
  width = 480,
  height = 56,
}: {
  days: UsageTrendDay[];
  totals: { pageviews: number; visitors: number };
  /** Internal SVG coordinate space — the element itself stretches to its container's width via
   * `preserveAspectRatio="none"` and a CSS `w-full`, so this only affects point-fitting math. */
  width?: number;
  height?: number;
}) => {
  if (days.length === 0) return null;

  const padding = 3;
  const pageviews = days.map((d) => d.pageviews);
  const visitors = days.map((d) => d.visitors);
  const [pageviewPoints, visitorPoints] = multiSeriesPoints(
    [pageviews, visitors],
    width,
    height,
    padding,
  );

  const baseline = height - padding;
  const areaPoints = `0,${String(baseline)} ${pageviewPoints} ${String(width)},${String(baseline)}`;

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      height={height}
      role="img"
      aria-label={`Pageviews: ${String(totals.pageviews)}, visitors: ${String(totals.visitors)} over the last ${String(days.length)} days`}
      preserveAspectRatio="none"
      className="w-full overflow-visible"
    >
      <polygon points={areaPoints} className="fill-amber-500/10" />
      <polyline
        points={pageviewPoints}
        fill="none"
        className="stroke-amber-500"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polyline
        points={visitorPoints}
        fill="none"
        className="stroke-sky-400"
        strokeWidth="1.5"
        strokeDasharray="3 2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
