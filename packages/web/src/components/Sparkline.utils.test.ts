import { describe, expect, it } from 'vitest';

import {
  isFlatSeries,
  multiSeriesPoints,
  sparklinePoints,
  sparklineTotal,
} from './Sparkline.utils.js';

describe('sparklineTotal', () => {
  it('sums a series', () => {
    expect(sparklineTotal([1, 2, 3])).toBe(6);
  });

  it('is 0 for an all-zero series', () => {
    expect(sparklineTotal([0, 0, 0])).toBe(0);
  });

  it('is 0 for an empty series', () => {
    expect(sparklineTotal([])).toBe(0);
  });
});

describe('isFlatSeries', () => {
  it('is true for an empty or single-point series', () => {
    expect(isFlatSeries([])).toBe(true);
    expect(isFlatSeries([5])).toBe(true);
  });

  it('is true for an all-zero series', () => {
    expect(isFlatSeries([0, 0, 0, 0])).toBe(true);
  });

  it('is true for an all-equal nonzero series', () => {
    expect(isFlatSeries([4, 4, 4])).toBe(true);
  });

  it('is false once any value differs', () => {
    expect(isFlatSeries([0, 0, 1])).toBe(false);
    expect(isFlatSeries([3, 5, 3])).toBe(false);
  });
});

describe('sparklinePoints', () => {
  it('is empty for an empty series', () => {
    expect(sparklinePoints([], 100, 32)).toBe('');
  });

  it('zero-data renders a flat baseline near the bottom, not an empty box', () => {
    const points = sparklinePoints([0, 0, 0, 0], 100, 32, 2);
    expect(points).not.toBe('');
    expect(points).toBe('0,30 100,30');
  });

  it('an all-equal nonzero series renders a flat line at mid-box', () => {
    const points = sparklinePoints([5, 5, 5], 100, 32, 2);
    expect(points).toBe('0,16 100,16');
  });

  it('a varying series spans the full height between min and max', () => {
    const points = sparklinePoints([0, 10], 100, 32, 2);
    // First point (min=0) sits at the padded bottom; last point (max=10) at the padded top.
    expect(points).toBe('0,30 100,2');
  });

  it('fits interior points proportionally between the min and max', () => {
    const points = sparklinePoints([0, 5, 10], 100, 32, 2);
    // x is spaced evenly across width; y=16 is exactly mid-way between the y=30 and y=2 extremes.
    expect(points).toBe('0,30 50,16 100,2');
  });

  it('a single nonzero point still produces a visible flat line, not a dot', () => {
    const points = sparklinePoints([7], 100, 32, 2);
    expect(points).toBe('0,16 100,16');
  });
});

describe('multiSeriesPoints', () => {
  it('is all-empty-strings for an empty series list', () => {
    expect(multiSeriesPoints([], 100, 32)).toEqual([]);
  });

  it('is all-empty-strings when any member series is zero-length', () => {
    expect(multiSeriesPoints([[1, 2], []], 100, 32)).toEqual(['', '']);
  });

  it('draws a flat baseline for every series when all values across all series are zero', () => {
    const [a, b] = multiSeriesPoints(
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      100,
      32,
      2,
    );
    expect(a).toBe('0,30 100,30');
    expect(b).toBe('0,30 100,30');
  });

  it('scales a flat/quiet series against the OTHER series’ range, not its own', () => {
    // The second series is constant at 0 — independently normalized it would be flat mid-box
    // (isFlatSeries treats a nonzero constant as mid-box), but on the shared 0..10 scale a
    // constant 0 belongs at the bottom, matching the busier series' own zero-point.
    const [busy, quiet] = multiSeriesPoints(
      [
        [0, 10],
        [0, 0],
      ],
      100,
      32,
      2,
    );
    expect(busy).toBe('0,30 100,2');
    expect(quiet).toBe('0,30 100,30');
  });

  it('places two series with different magnitudes on one shared scale', () => {
    const [big, small] = multiSeriesPoints(
      [
        [0, 20],
        [0, 10],
      ],
      100,
      32,
      2,
    );
    expect(big).toBe('0,30 100,2'); // 20 is the shared max -> top
    expect(small).toBe('0,30 100,16'); // 10 is exactly mid-way between shared min 0 and max 20
  });

  it('a shared flat nonzero range draws every series at mid-box', () => {
    const [a, b] = multiSeriesPoints(
      [
        [4, 4],
        [4, 4],
      ],
      100,
      32,
      2,
    );
    expect(a).toBe('0,16 100,16');
    expect(b).toBe('0,16 100,16');
  });
});
