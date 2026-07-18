import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, type Issue, type Project as ProjectT } from '../api.js';
import { Project } from './Project.js';

const buildRouter = (initialPath: string) => {
  const rootRoute = createRootRoute();
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectId',
    component: Project,
  });
  const routeTree = rootRoute.addChildren([projectRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

const sampleProject: ProjectT = {
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  publicKey: 'pk_1',
  webhookUrl: null,
  alertDedupeMinutes: 30,
  createdAt: Date.now(),
};

const renderProject = () => {
  const router = buildRouter('/projects/p1');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('Project issues list (M7: status tabs + pagination)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [sampleProject] });
    vi.spyOn(api, 'listIssues').mockResolvedValue({ issues: [], total: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to the "open" tab and sends status + sort explicitly (not omitted)', async () => {
    renderProject();

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'open',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });
    expect(screen.getByRole('tab', { name: 'open' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switching to the "resolved" tab re-queries with status=resolved at offset 0', async () => {
    renderProject();

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'open',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'resolved' }));

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'resolved',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });
    expect(screen.getByRole('tab', { name: 'resolved' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'open' })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking a status tab does not re-request the previous status again afterwards', async () => {
    renderProject();
    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'open',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'ignored' }));

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'ignored',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });
    // Only ever asked for 'open' once (the initial default) and 'ignored' once — no redundant
    // re-fetch of the tab we left.
    const openCalls = vi
      .mocked(api.listIssues)
      .mock.calls.filter(([, opts]) => opts?.status === 'open');
    expect(openCalls).toHaveLength(1);
  });

  it('shows a "regressed" tab between open and resolved', async () => {
    renderProject();
    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalled();
    });

    const tabs = screen.getAllByRole('tab').map((el) => el.textContent);
    expect(tabs).toEqual(['open', 'regressed', 'resolved', 'ignored']);
  });

  it('switching to the "regressed" tab re-queries with status=regressed', async () => {
    renderProject();
    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'regressed' }));

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'regressed',
        sort: 'lastSeen',
        limit: 25,
        offset: 0,
      });
    });
    expect(screen.getByRole('tab', { name: 'regressed' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Project issues list sort control (v0.3 item 1)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [sampleProject] });
    vi.spyOn(api, 'listIssues').mockResolvedValue({ issues: [], total: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to sort=lastSeen', async () => {
    renderProject();
    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ sort: 'lastSeen' }),
      );
    });
    expect(screen.getByRole('combobox', { name: 'Sort issues' })).toHaveValue('lastSeen');
  });

  it('changing the sort dropdown re-queries with the new sort and resets to offset 0', async () => {
    renderProject();
    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ sort: 'lastSeen' }),
      );
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort issues' }), {
      target: { value: 'eventCount' },
    });

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'open',
        sort: 'eventCount',
        limit: 25,
        offset: 0,
      });
    });
  });
});

describe('Project issues list regressed badge (v0.3 item 2)', () => {
  const regressedIssue: Issue = {
    id: 'i1',
    projectId: 'p1',
    fingerprint: 'fp1',
    title: 'Boom',
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    eventCount: 3,
    status: 'regressed',
    lastAlertedAt: null,
  };

  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [sampleProject] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a visible "Regressed" badge for a regressed issue row', async () => {
    vi.spyOn(api, 'listIssues').mockResolvedValue({ issues: [regressedIssue], total: 1 });
    renderProject();

    expect(await screen.findByText('Regressed')).toBeInTheDocument();
  });
});

describe('Project issues list platform badge (v0.4 CONTRACT P)', () => {
  const baseIssue: Issue = {
    id: 'i1',
    projectId: 'p1',
    fingerprint: 'fp1',
    title: 'Boom',
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    eventCount: 3,
    status: 'open',
    lastAlertedAt: null,
  };

  beforeEach(() => {
    vi.spyOn(api, 'listProjects').mockResolvedValue({ projects: [sampleProject] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a platform badge on a row whose issue has a platform', async () => {
    vi.spyOn(api, 'listIssues').mockResolvedValue({
      issues: [{ ...baseIssue, platform: 'android' }],
      total: 1,
    });
    renderProject();

    expect(await screen.findByText('android')).toBeInTheDocument();
  });

  it('shows no platform badge on a row whose issue has none (null or absent)', async () => {
    vi.spyOn(api, 'listIssues').mockResolvedValue({
      issues: [
        { ...baseIssue, id: 'i1', platform: null },
        { ...baseIssue, id: 'i2', title: 'Kaboom', fingerprint: 'fp2' },
      ],
      total: 2,
    });
    renderProject();

    await screen.findByText('Boom');
    await screen.findByText('Kaboom');
    for (const p of ['ios', 'android', 'web', 'node']) {
      expect(screen.queryByText(p)).not.toBeInTheDocument();
    }
  });
});
