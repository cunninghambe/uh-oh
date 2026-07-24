import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MergedBadge } from './MergedBadge.js';

describe('MergedBadge (v0.9 CONTRACT — SPEC §24 issue merge)', () => {
  it('renders a visible "Merged" badge', () => {
    render(<MergedBadge />);
    expect(screen.getByText('Merged')).toBeInTheDocument();
  });
});
