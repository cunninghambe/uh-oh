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

import { MAX_SYMBOL_UPLOAD_BYTES, api, type Project, type Release } from '../api.js';
import { Releases } from './Releases.js';

const buildRouter = () => {
  const rootRoute = createRootRoute();
  const releasesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/projects/$projectId/releases',
    component: Releases,
  });
  const routeTree = rootRoute.addChildren([releasesRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/projects/p1/releases'] }),
  });
};

const sampleProject: Project = {
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  publicKey: 'pk_1',
  webhookUrl: null,
  alertDedupeMinutes: 30,
  createdAt: Date.now(),
};

const sampleRelease: Release = {
  id: 'r1',
  projectId: 'p1',
  version: '1.2.3',
  build: '47',
  platform: 'android',
  mappingUploadedAt: null,
  sourcemapUploadedAt: null,
};

const renderReleases = () => {
  const router = buildRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('Releases symbol upload (M9: drag-drop + client size pre-check)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    vi.spyOn(api, 'listReleases').mockResolvedValue({ releases: [sampleRelease] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a drop event on the mapping dropzone starts the upload with the dropped file', async () => {
    vi.spyOn(api, 'uploadSymbols').mockResolvedValue({ release: sampleRelease });
    renderReleases();

    const label = await screen.findByText(/Mapping — drag & drop/i);
    const dropzone = label.parentElement;
    expect(dropzone).not.toBeNull();

    const file = new File(['mapping content'], 'mapping.txt', { type: 'text/plain' });
    fireEvent.drop(dropzone!, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(api.uploadSymbols).toHaveBeenCalledWith(
        'r1',
        file,
        expect.objectContaining({ sourcemap: false }),
      );
    });
  });

  it('an oversize file is rejected client-side — no network call — with a friendly error', async () => {
    const uploadSpy = vi.spyOn(api, 'uploadSymbols').mockResolvedValue({ release: sampleRelease });
    renderReleases();

    const label = await screen.findByText(/Mapping — drag & drop/i);
    const dropzone = label.parentElement;

    const oversizeFile = new File(['x'], 'mapping.txt', { type: 'text/plain' });
    Object.defineProperty(oversizeFile, 'size', { value: MAX_SYMBOL_UPLOAD_BYTES + 1 });

    fireEvent.drop(dropzone!, { dataTransfer: { files: [oversizeFile] } });

    await waitFor(() => {
      expect(screen.getByText(/the server limit is 50\.0MB/i)).toBeInTheDocument();
    });
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});
