// Integration coverage for the v0.5 additions to Issue.tsx: CodeContext wiring (CONTRACT S) and
// the Impact panel (CONTRACT I). Component-level behavior for each is already covered by
// CodeContext.test.tsx / ImpactPanel.test.tsx — this file only checks that Issue.tsx mounts them
// correctly (or gracefully doesn't) given real API responses.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  api,
  type Breadcrumb,
  type EventRow,
  type FixAttempt,
  type Issue as IssueT,
  type Project as ProjectT,
  type ResolvedFrame,
} from '../api.js';
import { Issue } from './Issue.js';

const buildRouter = (initialPath: string) => {
  const rootRoute = createRootRoute();
  const issueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/issues/$issueId',
    component: Issue,
  });
  const routeTree = rootRoute.addChildren([issueRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
};

const baseIssue: IssueT = {
  id: 'i1',
  projectId: 'p1',
  fingerprint: 'fp1',
  title: 'Boom',
  firstSeen: Date.now(),
  lastSeen: Date.now(),
  eventCount: 1,
  status: 'open',
  lastAlertedAt: null,
};

const baseEvent: EventRow = {
  id: 'e1',
  projectId: 'p1',
  issueId: 'i1',
  releaseId: null,
  fingerprint: 'fp1',
  level: 'error',
  platform: 'web',
  payload: JSON.stringify({
    exception: {
      stacktrace: [{ function: 'crashHere', filename: 'app/widget.js', lineno: 10, inApp: true }],
    },
  }),
  receivedAt: Date.now(),
  deviceInfo: '{}',
  userInfo: null,
};

const breadcrumbs: Breadcrumb[] = [];

const sampleProject: ProjectT = {
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  publicKey: 'pk_1',
  webhookUrl: null,
  repoUrl: null,
  alertDedupeMinutes: 30,
  createdAt: Date.now(),
};

const renderIssue = () => {
  const router = buildRouter('/issues/i1');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
};

describe('Issue page — v0.5 CONTRACT S (code frames)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a "Source" toggle for a symbolicated frame that carries context', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    const resolved: ResolvedFrame = {
      function: 'crashHere',
      filename: 'app/widget.js',
      lineno: 10,
      status: 'ok',
      context: { pre: ['function crashHere() {'], line: '  throw new Error();', post: ['}'] },
    };
    vi.spyOn(api, 'getEvent').mockResolvedValue({
      event: baseEvent,
      breadcrumbs,
      frames: [resolved],
    });

    renderIssue();

    expect(await screen.findByText('Source')).toBeInTheDocument();
  });

  it('renders no "Source" toggle for a frame without context (pre-v0.5 server, or out-of-app frame)', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({
      event: baseEvent,
      breadcrumbs,
      frames: [{ function: 'crashHere', filename: 'app/widget.js', lineno: 10, status: 'ok' }],
    });

    renderIssue();

    await screen.findByText('crashHere');
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });
});

describe('Issue page — v0.5 CONTRACT I (impact panel)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Impact panel when the impact endpoint returns data', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getIssueImpact').mockResolvedValue({
      distinctUsers: 3,
      topDevices: [],
      topOs: [],
      releases: [],
      platforms: [{ platform: 'web', events: 7 }],
    });

    renderIssue();

    expect(await screen.findByText('Impact')).toBeInTheDocument();
    expect(screen.getByText('distinct users affected')).toBeInTheDocument();
  });

  it('renders no Impact section when the impact endpoint 404s (server v0.5 not landed yet)', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    await screen.findByText('Boom');
    await waitFor(() => {
      expect(api.getIssueImpact).toHaveBeenCalled();
    });
    expect(screen.queryByText('Impact')).not.toBeInTheDocument();
  });
});

describe('Issue page — v0.8 CONTRACT (SPEC §23 spike badge)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a Spike badge in the header when the issue is actively spiking', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: { ...baseIssue, spikeActive: true },
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    expect(await screen.findByText('Spike')).toBeInTheDocument();
  });

  it('renders no Spike badge when the issue is not spiking (false or absent)', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: { ...baseIssue, spikeActive: false },
      latestEvent: baseEvent,
      breadcrumbs,
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    await screen.findByText('Boom');
    expect(screen.queryByText('Spike')).not.toBeInTheDocument();
  });
});

describe('Issue page — v0.8 CONTRACT (SPEC §23 fix attempts panel wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseFixAttempt: FixAttempt = {
    id: 'fa1',
    prUrl: 'https://github.com/org/repo/pull/1',
    commitSha: 'abcdef0123456',
    state: 'filed',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('renders the panel with an empty state when fixAttempts is present but empty', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
      fixAttempts: [],
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    expect(await screen.findByText('Fix attempts')).toBeInTheDocument();
    expect(screen.getByText('No fix attempts yet.')).toBeInTheDocument();
  });

  it('renders no Fix attempts panel when fixAttempts is absent (older server)', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
      // fixAttempts intentionally omitted — mirrors an older server's JSON.
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockResolvedValue({ project: sampleProject });
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    await screen.findByText('Boom');
    expect(screen.queryByText('Fix attempts')).not.toBeInTheDocument();
  });

  it("links a fix attempt's commit SHA using the project's repoUrl", async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
      fixAttempts: [baseFixAttempt],
    });
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockResolvedValue({
      project: { ...sampleProject, repoUrl: 'https://github.com/org/repo' },
    });
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));

    renderIssue();

    const link = await screen.findByRole('link', { name: 'abcdef0' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/commit/abcdef0123456');
  });
});

describe('Issue page — v0.9 CONTRACT (SPEC §24 issue merge)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mockCommonQueries = (): void => {
    vi.spyOn(api, 'listIssueEvents').mockResolvedValue({ events: [], total: 0 });
    vi.spyOn(api, 'getIssueImpact').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'getEvent').mockResolvedValue({ event: baseEvent, breadcrumbs, frames: [] });
    vi.spyOn(api, 'getProject').mockRejectedValue(new ApiError(404, 'not found'));
    vi.spyOn(api, 'listIssueAnnotations').mockRejectedValue(new ApiError(404, 'not found'));
  };

  it('shows a Merged badge and a link to the target issue for a merged issue, and no status toggle', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: { ...baseIssue, status: 'merged' },
      latestEvent: baseEvent,
      breadcrumbs,
      // mergedInto is a SIBLING of `issue` on the real detail response (derived
      // from fingerprint_aliases server-side), not an issue column.
      mergedInto: 'i9',
    });
    mockCommonQueries();

    renderIssue();

    expect(await screen.findByText('Merged')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'i9' });
    expect(link).toHaveAttribute('href', '/issues/i9');
    // A merged issue is terminal — no open/resolved/ignored toggle and no Merge button.
    expect(screen.queryByRole('button', { name: 'open' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Merge' })).not.toBeInTheDocument();
  });

  it('renders no Merged banner for a non-merged issue', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    mockCommonQueries();

    renderIssue();

    await screen.findByText('Boom');
    expect(screen.queryByText('Merged')).not.toBeInTheDocument();
  });

  it('a non-merged issue shows a Merge button that opens the merge modal', async () => {
    vi.spyOn(api, 'getIssue').mockResolvedValue({
      issue: baseIssue,
      latestEvent: baseEvent,
      breadcrumbs,
    });
    mockCommonQueries();
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });

    renderIssue();

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));

    expect(await screen.findByRole('dialog', { name: 'Merge issue' })).toBeInTheDocument();
  });

  it('a successful merge navigates to the target issue', async () => {
    vi.spyOn(api, 'getIssue').mockImplementation((id: string) =>
      Promise.resolve(
        id === 'i9'
          ? {
              issue: { ...baseIssue, id: 'i9', title: 'Target issue' },
              latestEvent: baseEvent,
              breadcrumbs,
            }
          : { issue: baseIssue, latestEvent: baseEvent, breadcrumbs },
      ),
    );
    mockCommonQueries();
    vi.spyOn(api, 'getSimilarIssues').mockResolvedValue({ similar: [] });
    vi.spyOn(api, 'mergeIssue').mockResolvedValue({ merged: true, mergedInto: 'i9' });

    renderIssue();

    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge issue' });
    await within(dialog).findByText('No similar issues found.');

    fireEvent.change(within(dialog).getByLabelText('Target issue id'), {
      target: { value: 'i9' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));

    expect(await screen.findByText('Target issue')).toBeInTheDocument();
  });
});
