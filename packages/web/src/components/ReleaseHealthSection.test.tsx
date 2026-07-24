import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type ReleaseHealth } from '../api.js';
import { ReleaseHealthSection } from './ReleaseHealthSection.js';

const emptyHealth: ReleaseHealth = {
  releases: [],
  totals: {
    events: 0,
    fatalEvents: 0,
    distinctIssues: 0,
    pageviews: 0,
    crashesPer1kPageviews: null,
  },
};

const populatedHealth: ReleaseHealth = {
  releases: [
    {
      id: 'r1',
      version: '1.2.3',
      build: '45',
      platform: 'android',
      commitSha: 'abcdef0123456',
      events: 20,
      fatalEvents: 5,
      distinctIssues: 3,
      firstEventAt: Date.now() - 100_000,
      lastEventAt: Date.now() - 1_000,
      pageviews: 0,
      crashesPer1kPageviews: null,
    },
    {
      id: 'r2',
      version: '1.2.2',
      build: '44',
      platform: 'web',
      commitSha: null,
      events: 10,
      fatalEvents: 2,
      distinctIssues: 1,
      firstEventAt: Date.now() - 200_000,
      lastEventAt: Date.now() - 50_000,
      pageviews: 4000,
      crashesPer1kPageviews: 2.5,
    },
  ],
  totals: {
    events: 30,
    fatalEvents: 7,
    distinctIssues: 4,
    pageviews: 4000,
    crashesPer1kPageviews: 7.5,
  },
};

const renderSection = (repoUrl: string | null | undefined = null) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReleaseHealthSection projectId="p1" repoUrl={repoUrl} />
    </QueryClientProvider>,
  );
};

describe('ReleaseHealthSection (v0.9 CONTRACT — SPEC §24 release health)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when the release-health endpoint 404s (server v0.9 not landed yet)', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderSection();

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('requests the default 30-day window', async () => {
    const spy = vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(emptyHealth);
    renderSection();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 30);
    });
  });

  it('shows an empty state when no releases have events in the window', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(emptyHealth);
    renderSection();

    expect(await screen.findByText('No releases with events in this window.')).toBeInTheDocument();
  });

  it('renders a row per release with version+build, platform, events, fatal, issues, pageviews', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(populatedHealth);
    renderSection();

    expect(await screen.findByText('1.2.3+45')).toBeInTheDocument();
    expect(screen.getByText('1.2.2+44')).toBeInTheDocument();
    expect(screen.getByText('android')).toBeInTheDocument();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument(); // r1 events
    expect(screen.getByText('5')).toBeInTheDocument(); // r1 fatalEvents
  });

  it('links the commit SHA via CommitLink when present, and dashes when absent', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(populatedHealth);
    renderSection('https://github.com/org/repo');

    const link = await screen.findByRole('link', { name: 'abcdef0' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef0123456');
    // r2 has no commitSha — falls back to a plain dash, no second link.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('renders a dash (not "0") for a release with zero pageviews — null ratio, not zero', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(populatedHealth);
    renderSection();

    await screen.findByText('1.2.3+45');
    // r1's crashesPer1kPageviews is null (pageviews: 0) — its badge shows '—'.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('renders the numeric ratio badge for a release with pageviews', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(populatedHealth);
    renderSection();

    expect(await screen.findByText('2.5')).toBeInTheDocument(); // r2's ratio
  });

  it('renders a totals row with project-wide numbers', async () => {
    vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(populatedHealth);
    renderSection();

    await screen.findByText('1.2.3+45');
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument(); // totals.events
    expect(screen.getByText('7.5')).toBeInTheDocument(); // totals ratio
  });

  it('the days selector re-fetches with the newly selected window and starts at 30', async () => {
    const spy = vi.spyOn(api, 'getReleaseHealth').mockResolvedValue(emptyHealth);
    renderSection();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 30);
    });
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '7d' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 7);
    });
    expect(screen.getByRole('button', { name: '7d' })).toHaveAttribute('aria-pressed', 'true');
  });
});
