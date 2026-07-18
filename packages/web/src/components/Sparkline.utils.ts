// Pure geometry helpers for the hand-rolled inline-SVG sparkline (v0.3 CONTRACT C), split out
// from Sparkline.tsx so the point-fitting math is unit-testable without rendering an SVG.

/** Sum of a day-stat series' `events` values — used for the accessible label's total. */
export const sparklineTotal = (values: number[]): number => values.reduce((sum, v) => sum + v, 0);

/** True when a series has no variance (including the empty/single-point case) — a straight
 * line is the correct rendering either way, not the normal per-point fit. */
export const isFlatSeries = (values: number[]): boolean => {
  if (values.length <= 1) return true;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max;
};

/**
 * Fit a non-negative number series into an SVG `points` attribute string for a `width` x
 * `height` box with `padding` vertical inset.
 *
 * A flat series (all-zero, or all-equal-nonzero) is drawn as a straight horizontal line rather
 * than running the normal min/max normalization (which would divide by zero) — zero-data draws
 * a flat baseline near the bottom of the box, matching "zero events" being the lowest possible
 * value; a flat nonzero series draws a flat line at mid-box.
 */
export const sparklinePoints = (
  values: number[],
  width: number,
  height: number,
  padding = 2,
): string => {
  if (values.length === 0) return '';

  if (isFlatSeries(values)) {
    const y = values[0] === 0 ? height - padding : height / 2;
    return `0,${String(y)} ${String(width)},${String(y)}`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const usableHeight = height - padding * 2;

  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const normalized = (v - min) / span;
      const y = height - padding - normalized * usableHeight;
      return `${String(x)},${String(y)}`;
    })
    .join(' ');
};
