import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UsageTrendChart, type UsageTrendDay } from './UsageTrendChart.js';

const days = (rows: [number, number][]): UsageTrendDay[] =>
  rows.map(([pageviews, visitors], i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    pageviews,
    visitors,
  }));

describe('UsageTrendChart', () => {
  it('renders nothing for an empty series (caller should hide the widget instead)', () => {
    const { container } = render(
      <UsageTrendChart days={[]} totals={{ pageviews: 0, visitors: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an accessible svg with both series’ totals in its label', () => {
    render(
      <UsageTrendChart
        days={days([
          [3, 1],
          [5, 2],
        ])}
        totals={{ pageviews: 8, visitors: 3 }}
      />,
    );
    expect(
      screen.getByRole('img', { name: 'Pageviews: 8, visitors: 3 over the last 2 days' }),
    ).toBeInTheDocument();
  });

  it('still renders visible (non-empty) lines for an all-zero series (flat baseline)', () => {
    render(
      <UsageTrendChart
        days={days([
          [0, 0],
          [0, 0],
        ])}
        totals={{ pageviews: 0, visitors: 0 }}
      />,
    );
    const svg = screen.getByRole('img');
    const polylines = svg.querySelectorAll('polyline');
    expect(polylines).toHaveLength(2);
    for (const line of polylines) {
      expect(line.getAttribute('points')).not.toBe('');
    }
  });

  it('renders two distinct polylines (pageviews and visitors) for varying data', () => {
    render(
      <UsageTrendChart
        days={days([
          [0, 0],
          [10, 4],
        ])}
        totals={{ pageviews: 10, visitors: 4 }}
      />,
    );
    const svg = screen.getByRole('img');
    const [pv, visitors] = svg.querySelectorAll('polyline');
    expect(pv?.getAttribute('points')).not.toBe(visitors?.getAttribute('points'));
  });

  it('draws a filled area under the pageviews line, not the visitors line', () => {
    render(
      <UsageTrendChart
        days={days([
          [0, 0],
          [10, 4],
        ])}
        totals={{ pageviews: 10, visitors: 4 }}
      />,
    );
    const svg = screen.getByRole('img');
    expect(svg.querySelectorAll('polygon')).toHaveLength(1);
  });
});
