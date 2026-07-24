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
import { EAGER_MAP_COUNT_THRESHOLD } from './Releases.utils.js';
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

describe('Releases map counts (v0.4 item 2: GET /api/releases/:id/symbols)', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a short list (<= threshold) fetches and shows counts eagerly, without interaction', async () => {
    vi.spyOn(api, 'listReleases').mockResolvedValue({ releases: [sampleRelease] });
    const symbolsSpy = vi.spyOn(api, 'getReleaseSymbols').mockResolvedValue({
      maps: [
        { platform: 'web', bundlePath: 'a.js', size: 10 },
        { platform: 'web', bundlePath: 'b.js', size: 10 },
        { platform: 'node', bundlePath: 'c.js', size: 10 },
      ],
    });
    renderReleases();

    expect(await screen.findByText('2 web maps · 1 node map')).toBeInTheDocument();
    expect(symbolsSpy).toHaveBeenCalledWith('r1');
  });

  it('shows nothing (no error banner) when the symbols request 404s / errors', async () => {
    vi.spyOn(api, 'listReleases').mockResolvedValue({ releases: [sampleRelease] });
    vi.spyOn(api, 'getReleaseSymbols').mockRejectedValue(new Error('not found'));
    renderReleases();

    // Let the (failed) request settle, then assert no count and no error text appeared.
    await waitFor(() => {
      expect(api.getReleaseSymbols).toHaveBeenCalled();
    });
    expect(screen.queryByText(/maps?/i, { selector: 'span' })).not.toBeInTheDocument();
  });

  it('a long list (> threshold) does not fetch on mount, only on hover of a row', async () => {
    const releases: Release[] = Array.from({ length: EAGER_MAP_COUNT_THRESHOLD + 1 }, (_, i) => ({
      ...sampleRelease,
      id: `r${String(i)}`,
      build: String(i),
    }));
    vi.spyOn(api, 'listReleases').mockResolvedValue({ releases });
    const symbolsSpy = vi
      .spyOn(api, 'getReleaseSymbols')
      .mockResolvedValue({ maps: [{ platform: 'web', bundlePath: 'a.js', size: 10 }] });
    renderReleases();

    const triggers = await screen.findAllByText('Maps…');
    expect(triggers).toHaveLength(releases.length);
    expect(symbolsSpy).not.toHaveBeenCalled();

    fireEvent.mouseEnter(triggers[0]!);

    await waitFor(() => {
      expect(symbolsSpy).toHaveBeenCalledTimes(1);
    });
    expect(symbolsSpy).toHaveBeenCalledWith('r0');
    expect(await screen.findByText('1 web map')).toBeInTheDocument();
  });
});

describe('Releases commit column (v0.8 CONTRACT — SPEC §23 release<->commit)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('links the short commit SHA when the release has one and the project repoUrl is https', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    vi.spyOn(api, 'listReleases').mockResolvedValue({
      releases: [{ ...sampleRelease, commitSha: 'abcdef0123456' }],
    });
    renderReleases();

    const link = await screen.findByRole('link', { name: 'abcdef0' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef0123456');
  });

  it('shows the short commit SHA as plain text when the project repoUrl is not https', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'git@github.com:org/repo.git' },
    });
    vi.spyOn(api, 'listReleases').mockResolvedValue({
      releases: [{ ...sampleRelease, commitSha: 'abcdef0123456' }],
    });
    renderReleases();

    expect(await screen.findByText('abcdef0')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'abcdef0' })).not.toBeInTheDocument();
  });

  it('shows a dash when the release has no commitSha', async () => {
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    vi.spyOn(api, 'listReleases').mockResolvedValue({ releases: [sampleRelease] });
    renderReleases();

    await screen.findByText('1.2.3+47');
    // { selector: 'span' } targets the commit cell's dash specifically — formatTs also renders
    // '—' (plain text, no wrapping span) for the two null upload timestamps on this same row.
    expect(screen.getByText('—', { selector: 'span' })).toBeInTheDocument();
  });
});
