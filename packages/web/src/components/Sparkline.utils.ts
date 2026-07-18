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
 * Core min/max-normalization shared by `sparklinePoints` (single series, its own extrema) and
 * `multiSeriesPoints` (v0.6 CONTRACT U-API — multiple series on one shared scale) — maps
 * `values` into an SVG `points` attribute string for a `width` x `height` box given an explicit
 * `range`, rather than each caller recomputing its own min/max.
 *
 * A flat range (`min === max`, including the empty/single-point case) is drawn as a straight
 * horizontal line rather than running the normal normalization (which would divide by zero) —
 * an all-zero range draws a flat baseline near the bottom of the box, matching "zero" being the
 * lowest possible value; a flat nonzero range draws a flat line at mid-box.
 */
const fitToRange = (
  values: number[],
  width: number,
  height: number,
  range: { min: number; max: number },
  padding: number,
): string => {
  if (values.length === 0) return '';

  const { min, max } = range;
  const span = max - min;

  if (span === 0) {
    const y = min === 0 ? height - padding : height / 2;
    return `0,${String(y)} ${String(width)},${String(y)}`;
  }

  const usableHeight = height - padding * 2;

  return values
    .map((v, i) => {
      const x = values.length === 1 ? 0 : (i / (values.length - 1)) * width;
      const normalized = (v - min) / span;
      const y = height - padding - normalized * usableHeight;
      return `${String(x)},${String(y)}`;
    })
    .join(' ');
};

/**
 * Fit a non-negative number series into an SVG `points` attribute string for a `width` x
 * `height` box with `padding` vertical inset, normalized against its own min/max (see
 * `fitToRange`'s doc comment for the flat-series behavior).
 */
export const sparklinePoints = (
  values: number[],
  width: number,
  height: number,
  padding = 2,
): string => {
  if (values.length === 0) return '';

  if (isFlatSeries(values)) {
    // `isFlatSeries` already established values.length > 0, so index 0 always exists — the `?? 0`
    // is only to satisfy noUncheckedIndexedAccess, not a real fallback.
    const v0 = values[0] ?? 0;
    return fitToRange(values, width, height, { min: v0, max: v0 }, padding);
  }

  return fitToRange(
    values,
    width,
    height,
    { min: Math.min(...values), max: Math.max(...values) },
    padding,
  );
};

/**
 * Shared-scale multi-series variant of `sparklinePoints` (v0.6 CONTRACT U-API — the Usage
 * section's trend chart plots pageviews and visitors on one set of axes). Computes ONE min/max
 * across every series so they share a common y-scale instead of each being independently
 * normalized, which would make a quiet series look as tall as a busy one. Returns one points
 * string per input series, same order. Series are assumed equal length; if `series` is empty or
 * any member is zero-length, every output is `''` (mirrors `sparklinePoints`' empty-series
 * behavior).
 */
export const multiSeriesPoints = (
  series: number[][],
  width: number,
  height: number,
  padding = 2,
): string[] => {
  if (series.length === 0 || series.some((s) => s.length === 0)) {
    return series.map(() => '');
  }

  const allValues = series.flat();
  const range = { min: Math.min(...allValues), max: Math.max(...allValues) };

  return series.map((values) => fitToRange(values, width, height, range, padding));
};
