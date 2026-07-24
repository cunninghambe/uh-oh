import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SpikeBadge } from './SpikeBadge.js';

describe('SpikeBadge', () => {
  it('renders visible "Spike" text', () => {
    render(<SpikeBadge />);
    expect(screen.getByText('Spike')).toBeInTheDocument();
  });
});
