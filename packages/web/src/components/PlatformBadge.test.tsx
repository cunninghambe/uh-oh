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
});
