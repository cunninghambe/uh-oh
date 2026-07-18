import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PlatformBadge } from './PlatformBadge.js';

describe('PlatformBadge', () => {
  it.each(['web', 'node', 'android', 'ios'] as const)(
    'renders the %s platform label',
    (platform) => {
      render(<PlatformBadge platform={platform} />);
      expect(screen.getByText(platform)).toBeInTheDocument();
    },
  );

  // v0.4 CONTRACT P: an issue (list row or detail) with no known platform must render no
  // badge at all, not an empty/placeholder one.
  it('renders nothing for a null platform', () => {
    const { container } = render(<PlatformBadge platform={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an undefined platform', () => {
    const { container } = render(<PlatformBadge platform={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
