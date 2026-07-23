// v0.8 CONTRACT (SPEC §23 release<->commit): coverage for the new repoUrl field alongside the
// pre-existing webhook URL / dedupe settings — round trip and clear-to-null, same convention as
// webhookUrl (untested here previously, so this file also covers the settings save flow at all).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, type Project } from '../api.js';
import { ProjectSettings } from './ProjectSettings.js';

const buildRouter = () => {
  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectId/settings',
    component: ProjectSettings,
  });
  const routeTree = rootRoute.addChildren([settingsRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/settings'] }),
  });
};

const sampleProject: Project = {
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  publicKey: 'pk_1',
  webhookUrl: null,
  repoUrl: null,
  alertDedupeMinutes: 30,
  createdAt: Date.now(),
};

const renderSettings = () => {
  const router = buildRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('ProjectSettings repoUrl field (v0.8 CONTRACT — SPEC §23 release<->commit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-fills the repo URL field from the project', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    renderSettings();

    const input = await screen.findByLabelText('Repo URL (optional)');
    await waitFor(() => {
      expect(input).toHaveValue('https://github.com/org/repo');
    });
  });

  it('leaves the repo URL field blank when the project has none', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    renderSettings();

    const input = await screen.findByLabelText('Repo URL (optional)');
    expect(input).toHaveValue('');
  });

  it('saving with a repo URL PATCHes the trimmed value', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    const updateSpy = vi.spyOn(api, 'updateProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    renderSettings();

    const input = await screen.findByLabelText('Repo URL (optional)');
    fireEvent.change(input, { target: { value: '  https://github.com/org/repo  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ repoUrl: 'https://github.com/org/repo' }),
      );
    });
  });

  it('clearing an existing repo URL PATCHes it to null', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    const updateSpy = vi
      .spyOn(api, 'updateProject')
      .mockResolvedValue({ project: { ...sampleProject, repoUrl: null } });
    renderSettings();

    const input = await screen.findByLabelText('Repo URL (optional)');
    await waitFor(() => {
      expect(input).toHaveValue('https://github.com/org/repo');
    });

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith('p1', expect.objectContaining({ repoUrl: null }));
    });
  });

  it('re-syncs the field from the server response after a successful save', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    vi.spyOn(api, 'updateProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    renderSettings();

    const input = await screen.findByLabelText('Repo URL (optional)');
    fireEvent.change(input, { target: { value: 'https://github.com/org/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Saved.');
    expect(input).toHaveValue('https://github.com/org/repo');
  });
});
