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

import { api, type Project as ProjectT } from '../api.js';
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

  it('defaults to the "open" tab and sends status explicitly (not omitted)', async () => {
    renderProject();

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', { status: 'open', limit: 25, offset: 0 });
    });
    expect(screen.getByRole('tab', { name: 'open' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switching to the "resolved" tab re-queries with status=resolved at offset 0', async () => {
    renderProject();

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', { status: 'open', limit: 25, offset: 0 });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'resolved' }));

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'resolved',
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
      expect(api.listIssues).toHaveBeenCalledWith('p1', { status: 'open', limit: 25, offset: 0 });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'ignored' }));

    await waitFor(() => {
      expect(api.listIssues).toHaveBeenCalledWith('p1', {
        status: 'ignored',
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
});
