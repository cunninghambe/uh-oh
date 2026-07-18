import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RegressedBadge } from './RegressedBadge.js';

describe('RegressedBadge', () => {
  it('renders visible "Regressed" text', () => {
    render(<RegressedBadge />);
    expect(screen.getByText('Regressed')).toBeInTheDocument();
  });
});
