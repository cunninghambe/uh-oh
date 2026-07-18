// Hand-rolled inline-SVG sparkline (v0.3 CONTRACT C — no charting dependency). Renders a 14-day
// events series as a polyline; callers are responsible for hiding this entirely on a failed
// stats fetch (404/error) — this component only handles the "we have data" case.

import { sparklinePoints, sparklineTotal } from './Sparkline.utils.js';

export type SparklinePoint = { date: string; events: number };

export const Sparkline = ({
  points,
  width = 120,
  height = 32,
  srLabel = 'Events',
  className = '',
}: {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  /** Short description prefixed to the accessible label, e.g. "Events" or "Issue events". */
  srLabel?: string;
  className?: string;
}) => {
  if (points.length === 0) return null;

  const values = points.map((p) => p.events);
  const total = sparklineTotal(values);
  const linePoints = sparklinePoints(values, width, height);

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${srLabel}: ${String(total)} over the last ${String(points.length)} days`}
      className={`overflow-visible ${className}`}
    >
      <polyline
        points={linePoints}
        fill="none"
        className="stroke-amber-500"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
