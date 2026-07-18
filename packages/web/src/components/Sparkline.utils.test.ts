import { describe, expect, it } from 'vitest';

import { isFlatSeries, sparklinePoints, sparklineTotal } from './Sparkline.utils.js';

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
