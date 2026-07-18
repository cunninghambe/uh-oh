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
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  api,
  type Breadcrumb,
  type EventRow,
  type Issue as IssueT,
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
