import { getToken, setToken } from './auth.js';

export type Project = {
  id: string;
  name: string;
  slug: string;
  publicKey: string;
  webhookUrl: string | null;
  alertDedupeMinutes: number;
  createdAt: number;
};

export type Release = {
  id: string;
  projectId: string;
  version: string;
  build: string;
  platform: 'ios' | 'android';
  mappingUploadedAt: number | null;
  sourcemapUploadedAt: number | null;
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

export type ResolvedFrame = {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  status: 'ok' | 'no_symbols' | 'unsymbolicated' | 'corrupt_mapping';
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as T;
};

const requestMultipart = async <T>(path: string, formData: FormData): Promise<T> => {
  const token = getToken();
  const res = await fetch(path, {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    setToken(null);
    window.location.href = '/login';
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as T;
};

export const api = {
  login: (password: string) =>
    request<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: () => request<void>('/api/auth/logout', { method: 'POST' }).catch(() => undefined),

  listProjects: () => request<{ projects: Project[] }>('/api/projects'),

  getProject: (id: string) => request<{ project: Project }>(`/api/projects/${id}`),

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

  listReleases: (projectId: string) =>
    request<{ releases: Release[] }>(`/api/projects/${projectId}/releases`),

  uploadSymbols: (
    releaseId: string,
    file: File,
    opts: { sourcemap?: boolean } = {},
  ): Promise<{ release: Release }> => {
    const form = new FormData();
    form.append('file', file);
    form.append('platform', 'android');
    if (opts.sourcemap) form.append('sourcemap', 'true');
    return requestMultipart<{ release: Release }>(`/api/releases/${releaseId}/symbols`, form);
  },

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

  getEvent: (id: string, opts: { symbolicate?: boolean } = {}) => {
    const qs = opts.symbolicate ? '?symbolicate=true' : '';
    return request<{
      event: EventRow;
      breadcrumbs: Breadcrumb[];
      frames?: ResolvedFrame[];
    }>(`/api/events/${id}${qs}`);
  },

  setIssueStatus: (id: string, status: Issue['status']) =>
    request<{ issue: Issue }>(`/api/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),
};
