import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type UsageSummary } from '../api.js';
import { UsageSection } from './UsageSection.js';

const emptySummary: UsageSummary = {
  days: [],
  topPages: [],
  topReferrers: [],
  topEvents: [],
  totals: { pageviews: 0, visitors: 0, events: 0 },
};

const populatedSummary: UsageSummary = {
  days: [
    { date: '2026-07-17', pageviews: 3, visitors: 2, events: 1 },
    { date: '2026-07-18', pageviews: 5, visitors: 3, events: 2 },
  ],
  topPages: [{ path: '/docs', pageviews: 6, visitors: 4 }],
  topReferrers: [{ referrer: 'google.com', pageviews: 2 }],
  topEvents: [{ name: 'signup_clicked', count: 3 }],
  totals: { pageviews: 8, visitors: 5, events: 3 },
};

const renderSection = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UsageSection projectId="p1" />
    </QueryClientProvider>,
  );
};

describe('UsageSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when the usage endpoint 404s (server v0.6 not landed yet)', async () => {
    vi.spyOn(api, 'getUsageSummary').mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderSection();

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('requests the default 30-day window', async () => {
    const spy = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(emptySummary);
    renderSection();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 30);
    });
  });

  it('renders headline totals (visitors/pageviews/custom events)', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue(populatedSummary);
    renderSection();

    expect(await screen.findByText('visitors')).toBeInTheDocument();
    expect(screen.getByText('pageviews')).toBeInTheDocument();
    expect(screen.getByText('custom events')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument(); // pageviews total
    expect(screen.getByText('5')).toBeInTheDocument(); // visitors total
  });

  it('shows the empty-state hint (not the lists grid) when every top-list is empty', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue(emptySummary);
    renderSection();

    expect(await screen.findByText(/No usage recorded yet/)).toBeInTheDocument();
    expect(screen.getByText(/@uh-oh\/js analytics option/)).toBeInTheDocument();
  });

  it('renders the three top-lists with their rows when populated', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue(populatedSummary);
    renderSection();

    expect(await screen.findByText('Top pages')).toBeInTheDocument();
    expect(screen.getByText('/docs')).toBeInTheDocument();
    expect(screen.getByText('Top referrers')).toBeInTheDocument();
    expect(screen.getByText('google.com')).toBeInTheDocument();
    expect(screen.getByText('Top events')).toBeInTheDocument();
    expect(screen.getByText('signup_clicked')).toBeInTheDocument();
    expect(screen.queryByText(/No usage recorded yet/)).not.toBeInTheDocument();
  });

  it('the days selector re-fetches with the newly selected window and starts at 30', async () => {
    const spy = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(populatedSummary);
    renderSection();

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 30);
    });
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '90d' }));

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('p1', 90);
    });
    expect(screen.getByRole('button', { name: '90d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers all three day options: 7, 30, 90', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue(emptySummary);
    renderSection();

    await screen.findByRole('heading', { name: 'Usage' });
    expect(screen.getByRole('button', { name: '7d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '90d' })).toBeInTheDocument();
  });
});
