import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sparkline, type SparklinePoint } from './Sparkline.js';

const days = (events: number[]): SparklinePoint[] =>
  events.map((e, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, events: e }));

describe('Sparkline', () => {
  it('renders nothing for an empty series (caller should hide the widget instead)', () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an accessible svg with the total in its label', () => {
    render(<Sparkline points={days([1, 2, 3])} srLabel="Events" />);
    expect(screen.getByRole('img', { name: 'Events: 6 over the last 3 days' })).toBeInTheDocument();
  });

  it('still renders a visible (non-empty) line for an all-zero series', () => {
    render(<Sparkline points={days([0, 0, 0, 0])} srLabel="Events" />);
    const svg = screen.getByRole('img', { name: 'Events: 0 over the last 4 days' });
    const polyline = svg.querySelector('polyline');
    expect(polyline).not.toBeNull();
    expect(polyline?.getAttribute('points')).not.toBe('');
  });
});
