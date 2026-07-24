import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommitLink } from './CommitLink.js';

describe('CommitLink (SPEC §23: linked when repoUrl is https, plain text otherwise)', () => {
  it('renders a link to <repoUrl>/commit/<sha> for an https repoUrl, truncated to 7 chars', () => {
    render(<CommitLink sha="abcdef0123456" repoUrl="https://github.com/org/repo" />);

    const link = screen.getByRole('link', { name: 'abcdef0' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef0123456');
  });

  it('renders plain text (no link) for a non-https repoUrl', () => {
    render(<CommitLink sha="abcdef0123456" repoUrl="git@github.com:org/repo.git" />);

    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain text (no link) when repoUrl is null', () => {
    render(<CommitLink sha="abcdef0123456" repoUrl={null} />);

    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain text (no link) when repoUrl is undefined (older server)', () => {
    render(<CommitLink sha="abcdef0123456" repoUrl={undefined} />);

    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
