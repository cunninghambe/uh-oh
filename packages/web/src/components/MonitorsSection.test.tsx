import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type Monitor } from '../api.js';
import { MonitorsSection } from './MonitorsSection.js';

const baseMonitor: Monitor = {
  id: 'm1',
  projectId: 'p1',
  slug: 'nightly-backup',
  name: null,
  intervalMinutes: 60,
  graceMinutes: 15,
  status: 'ok',
  lastCheckInAt: Date.now() - 5 * 60_000,
  createdAt: Date.now() - 100_000,
  overdue: false,
};

const renderSection = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MonitorsSection projectId="p1" publicKey="pk_test123" />
    </QueryClientProvider>,
  );
};

describe('MonitorsSection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when the monitors endpoint 404s (server v0.5 not landed yet)', async () => {
    vi.spyOn(api, 'listMonitors').mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderSection();

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('shows the empty state with the check-in URL (real publicKey substituted) when there are no monitors', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [] });
    renderSection();

    expect(await screen.findByText(/No monitors yet/)).toBeInTheDocument();
    expect(
      screen.getByText('POST /ingest/pk_test123/check-in/<slug>?intervalMinutes=N'),
    ).toBeInTheDocument();
  });

  it('explains monitors are created by check-in, not by the UI, even when the list is populated', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    renderSection();

    await screen.findByText('nightly-backup');
    expect(
      screen.getByText(/Created automatically by a project's first check-in/),
    ).toBeInTheDocument();
  });

  it('renders slug, interval/grace, and last check-in for each row', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    renderSection();

    expect(await screen.findByText('nightly-backup')).toBeInTheDocument();
    expect(screen.getByText(/every 60m, grace 15m/)).toBeInTheDocument();
    expect(screen.getByText(/last check-in: 5m ago/)).toBeInTheDocument();
  });

  it('shows "never" for last check-in when a monitor has none', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({
      monitors: [{ ...baseMonitor, lastCheckInAt: null }],
    });
    renderSection();

    expect(await screen.findByText(/last check-in: never/)).toBeInTheDocument();
  });

  it('gives a missed monitor a prominent (red) status pill', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({
      monitors: [{ ...baseMonitor, status: 'missed' }],
    });
    renderSection();

    const pill = await screen.findByText('missed');
    expect(pill).toHaveClass('font-semibold');
  });

  it('shows an "overdue" chip for an overdue monitor that has not flipped to missed yet', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({
      monitors: [{ ...baseMonitor, overdue: true }],
    });
    renderSection();

    expect(await screen.findByText('overdue')).toBeInTheDocument();
  });

  it('pausing an ok monitor PATCHes status:paused', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    const updateSpy = vi
      .spyOn(api, 'updateMonitor')
      .mockResolvedValue({ monitor: { ...baseMonitor, status: 'paused' } });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('m1', { status: 'paused' });
    });
  });

  it('resuming a paused monitor PATCHes status:ok', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({
      monitors: [{ ...baseMonitor, status: 'paused' }],
    });
    const updateSpy = vi
      .spyOn(api, 'updateMonitor')
      .mockResolvedValue({ monitor: { ...baseMonitor, status: 'ok' } });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('m1', { status: 'ok' });
    });
  });

  it('editing name/interval/grace inline PATCHes the changed values', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    const updateSpy = vi.spyOn(api, 'updateMonitor').mockResolvedValue({ monitor: baseMonitor });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const intervalInput = screen.getByLabelText('Interval (min)');
    fireEvent.change(intervalInput, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('m1', {
        intervalMinutes: 30,
        graceMinutes: 15,
      });
    });
  });

  it('deleting a monitor requires a confirm click before calling the API', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    const deleteSpy = vi.spyOn(api, 'deleteMonitor').mockResolvedValue(undefined);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith('m1');
    });
  });
});

describe('MonitorsSection — v0.9 CONTRACT (SPEC §24 uptime probes)', () => {
  const httpMonitor: Monitor = {
    id: 'm2',
    projectId: 'p1',
    slug: 'api-health',
    name: null,
    intervalMinutes: 5,
    graceMinutes: 15,
    status: 'ok',
    lastCheckInAt: null,
    createdAt: Date.now() - 100_000,
    overdue: false,
    kind: 'http',
    url: 'https://example.com/health',
    timeoutMs: 10_000,
    lastProbeAt: Date.now() - 3 * 60_000,
    lastProbeStatus: 200,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a kind badge, the URL, and the last probe status for an http monitor row', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [httpMonitor] });
    renderSection();

    expect(await screen.findByText('api-health')).toBeInTheDocument();
    expect(screen.getByText('HTTP')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/health')).toBeInTheDocument();
    expect(screen.getByText(/last probe: 200 \(3m ago\)/)).toBeInTheDocument();
    // Still shares the same ok/missed/paused status pill as check-in monitors.
    expect(screen.getByText('ok', { exact: true })).toBeInTheDocument();
  });

  it('shows "never" for an http monitor that has not been probed yet', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({
      monitors: [{ ...httpMonitor, lastProbeAt: null, lastProbeStatus: null }],
    });
    renderSection();

    expect(await screen.findByText(/last probe: never/)).toBeInTheDocument();
  });

  it('shows no kind badge and the check-in display for a plain check-in monitor', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [baseMonitor] });
    renderSection();

    await screen.findByText('nightly-backup');
    expect(screen.queryByText('HTTP')).not.toBeInTheDocument();
    expect(screen.getByText(/every 60m, grace 15m/)).toBeInTheDocument();
  });

  it('renders an "+ Add HTTP monitor" button that reveals a create form', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [] });
    renderSection();

    await screen.findByText(/No monitors yet/);
    expect(screen.queryByLabelText('Slug')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Add HTTP monitor' }));

    expect(screen.getByLabelText('Slug')).toBeInTheDocument();
    expect(screen.getByLabelText('URL')).toBeInTheDocument();
  });

  it('submitting the create form POSTs kind:http with slug/url/intervalMinutes/timeoutMs', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [] });
    const createSpy = vi.spyOn(api, 'createMonitor').mockResolvedValue({ monitor: httpMonitor });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: '+ Add HTTP monitor' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'api-health' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/health' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith('p1', {
        kind: 'http',
        slug: 'api-health',
        url: 'https://example.com/health',
        intervalMinutes: 5,
        timeoutMs: 10_000,
      });
    });
  });

  it('the create submit button is disabled for an invalid slug', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [] });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: '+ Add HTTP monitor' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'API health!' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/health' },
    });

    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('surfaces a create error as visible text', async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [] });
    vi.spyOn(api, 'createMonitor').mockRejectedValue(new ApiError(400, 'invalid_url'));
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: '+ Add HTTP monitor' }));
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'api-health' } });
    fireEvent.change(screen.getByLabelText('URL'), {
      target: { value: 'https://example.com/health' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('invalid_url')).toBeInTheDocument();
  });

  it("editing an http monitor's row shows URL/Timeout fields, not Grace", async () => {
    vi.spyOn(api, 'listMonitors').mockResolvedValue({ monitors: [httpMonitor] });
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText('URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Timeout (ms)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Grace (min)')).not.toBeInTheDocument();
  });
});
