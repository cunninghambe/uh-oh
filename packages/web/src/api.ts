export type Project = {
  id: string;
  name: string;
  slug: string;
  publicKey: string;
  webhookUrl: string | null;
  alertDedupeMinutes: number;
  createdAt: number;
};

export type Issue = {
  id: string;
  projectId: string;
  fingerprint: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  status: 'open' | 'resolved' | 'ignored';
  lastAlertedAt: number | null;
};

export type EventRow = {
  id: string;
  projectId: string;
  issueId: string;
  releaseId: string | null;
  fingerprint: string;
  level: string;
  platform: 'ios' | 'android';
  payload: string;
  receivedAt: number;
  deviceInfo: string;
  userInfo: string | null;
};

export type Breadcrumb = {
  eventId: string;
  idx: number;
  ts: number;
  category: string;
  level: string;
  message: string;
  data: string | null;
};

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as T;
};

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (name: string) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updateProject: (
    id: string,
    patch: Partial<Pick<Project, 'webhookUrl' | 'alertDedupeMinutes' | 'name'>>,
  ) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  rotateKey: (id: string) =>
    request<{ project: Project }>(`/api/projects/${id}/rotate-key`, { method: 'POST' }),
  listIssues: (
    projectId: string,
    opts: { status?: string; limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return request<{ issues: Issue[]; total: number }>(
      `/api/projects/${projectId}/issues${qs ? `?${qs}` : ''}`,
    );
  },
  getIssue: (id: string) =>
    request<{ issue: Issue; latestEvent: EventRow | null; breadcrumbs: Breadcrumb[] }>(
      `/api/issues/${id}`,
    ),
  setIssueStatus: (id: string, status: Issue['status']) =>
    request<{ issue: Issue }>(`/api/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
};

export { ApiError };
