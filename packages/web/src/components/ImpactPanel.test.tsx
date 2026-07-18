import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ImpactSummary } from '../api.js';
import { ImpactPanel } from './ImpactPanel.js';

const empty: ImpactSummary = {
  distinctUsers: null,
  topDevices: [],
  topOs: [],
  releases: [],
  platforms: [],
};

describe('ImpactPanel', () => {
  it('renders nothing when there is no data at all', () => {
    const { container } = render(<ImpactPanel impact={empty} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the distinct-users stat when null but still shows populated lists', () => {
    render(<ImpactPanel impact={{ ...empty, topDevices: [{ model: 'Pixel 8', events: 4 }] }} />);
    expect(screen.queryByText(/distinct user/)).not.toBeInTheDocument();
    expect(screen.getByText('Pixel 8')).toBeInTheDocument();
  });

  it('shows the distinct-users stat (singular) when it is 1', () => {
    render(<ImpactPanel impact={{ ...empty, distinctUsers: 1 }} />);
    expect(screen.getByText('distinct user affected')).toBeInTheDocument();
  });

  it('shows the distinct-users stat (plural) when greater than 1', () => {
    render(<ImpactPanel impact={{ ...empty, distinctUsers: 42 }} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('distinct users affected')).toBeInTheDocument();
  });

  it('shows the distinct-users stat even when it is 0 (0 is not null)', () => {
    render(<ImpactPanel impact={{ ...empty, distinctUsers: 0 }} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  it('skips empty lists and only renders populated ones, each with a title', () => {
    render(
      <ImpactPanel
        impact={{
          ...empty,
          releases: [{ release: '1.2.0+40', events: 9 }],
          platforms: [{ platform: 'web', events: 3 }],
        }}
      />,
    );
    expect(screen.getByText('Releases')).toBeInTheDocument();
    expect(screen.getByText('Platforms')).toBeInTheDocument();
    expect(screen.queryByText('Devices')).not.toBeInTheDocument();
    expect(screen.queryByText('OS')).not.toBeInTheDocument();
  });

  it('renders the event count next to each row', () => {
    render(<ImpactPanel impact={{ ...empty, topDevices: [{ model: 'Pixel 8', events: 12 }] }} />);
    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
