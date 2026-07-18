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
  platform: 'ios' | 'android' | 'web' | 'node';
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
  // 'regressed' is system-set when a resolved issue recurs (v0.3 CONTRACT B); users can still
  // PATCH the other three values but never set 'regressed' directly.
  status: 'open' | 'resolved' | 'ignored' | 'regressed';
  lastAlertedAt: number | null;
  // v0.4 CONTRACT P: server-set from the issue's latest event, nullable (an issue with no
  // events, or one predating migration 0004, has none). Optional too so this type stays
  // forward-compatible if an older server build omits the field entirely.
  platform?: 'ios' | 'android' | 'web' | 'node' | null;
};

export type EventRow = {
  id: string;
  projectId: string;
  issueId: string;
  releaseId: string | null;
  fingerprint: string;
  level: string;
  platform: 'ios' | 'android' | 'web' | 'node';
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

// v0.3 CONTRACT C: GET /api/projects/:id/stats?days= and /api/issues/:id/stats?days=.
// `days` is ascending and zero-filled by the server (one entry per calendar day, no gaps).
export type DayStat = {
  date: string;
  events: number;
};

export type ProjectStats = {
  days: DayStat[];
  totalOpenIssues: number;
};

export type IssueStats = {
  days: DayStat[];
};

/** Server-side cap on symbol upload size (mapping.txt / sourcemap.map). Checked client-side too. */
export const MAX_SYMBOL_UPLOAD_BYTES = 50 * 1024 * 1024;

// v0.4 item 2: GET /api/releases/:id/symbols (exists since v0.3) — one entry per uploaded
// per-bundle web/node source map for a release.
export type ReleaseSymbolMap = {
  platform: 'web' | 'node';
  bundlePath: string;
  size: number;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const LOGIN_PATH = '/api/auth/login';

// The global 401 handler must not fire for the login endpoint itself — a wrong-password
// attempt returns 401 by design, and redirecting to /login (where we already are) wipes
// the error state before it renders. See SPEC §13 "wrong password shows error".
//
// This is registered by the router module (router.tsx) rather than imported statically here,
// so api.ts stays decoupled from the router and safe to unit-test without a router context.
type UnauthorizedHandler = (redirectPath: string) => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export const setUnauthorizedHandler = (fn: UnauthorizedHandler | null): void => {
  unauthorizedHandler = fn;
};

const handleUnauthorized = (): void => {
  setToken(null);
  const redirectPath =
    typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
  if (unauthorizedHandler) {
    unauthorizedHandler(redirectPath);
  } else if (typeof window !== 'undefined') {
    // Fallback for the (unexpected) case navigation wasn't wired up yet — better a full
    // reload than a stuck screen.
    window.location.href = `/login?redirect=${encodeURIComponent(redirectPath)}`;
  }
};

const parseErrorBody = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return body.message ?? body.error ?? `HTTP ${String(res.status)}`;
};

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
  if (res.status === 401 && path !== LOGIN_PATH) {
    handleUnauthorized();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
  }
  return (await res.json()) as T;
};

const uploadWithProgress = <T>(
  path: string,
  form: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      let body: unknown = {};
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }
      if (xhr.status === 401) {
        handleUnauthorized();
        reject(new ApiError(401, 'unauthorized'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      const b = body as { error?: string; message?: string };
      reject(new ApiError(xhr.status, b.message ?? b.error ?? `HTTP ${String(xhr.status)}`));
    };

    xhr.onerror = () => {
      reject(new ApiError(0, 'Network error'));
    };

    xhr.send(form);
  });

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

  // XHR (not fetch) so upload.onprogress can drive a real progress bar — fetch has no
  // cross-browser-reliable upload progress API. See SPEC §13 "see upload progress".
  uploadSymbols: (
    releaseId: string,
    file: File,
    opts: { sourcemap?: boolean; onProgress?: (percent: number) => void } = {},
  ): Promise<{ release: Release }> => {
    const form = new FormData();
    form.append('file', file);
    form.append('platform', 'android');
    if (opts.sourcemap) form.append('sourcemap', 'true');
    return uploadWithProgress(`/api/releases/${releaseId}/symbols`, form, opts.onProgress);
  },

  // NOTE (spec delta): SPEC §9 documents this route as `?status=&sort=&page=&limit=`, but the
  // implemented API is offset-based (`offset`, not `page`) — matches the pre-existing code
  // here, unchanged. `sort` (lastSeen|eventCount|firstSeen) is pre-existing server support
  // (v0.3 brief item 1, not part of the concurrent CONTRACT work) and is now sent.
  listIssues: (
    projectId: string,
    opts: { status?: string; sort?: string; limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.sort) params.set('sort', opts.sort);
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

  // SPEC §9: GET /api/issues/:id/events?page=&limit= — page-based (1-indexed), unlike
  // listIssues which is offset-based (see the offset-vs-page note in api.ts's listIssues).
  listIssueEvents: (issueId: string, opts: { page?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.page) params.set('page', String(opts.page));
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return request<{ events: EventRow[]; total: number }>(
      `/api/issues/${issueId}/events${qs ? `?${qs}` : ''}`,
    );
  },

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

  // v0.3 CONTRACT C — server agent work landing concurrently. Callers must treat a failed
  // request (404 while unimplemented, or any other error) as "no stats available" and hide
  // the sparkline, not surface an error state.
  getProjectStats: (projectId: string, days = 14) =>
    request<ProjectStats>(`/api/projects/${projectId}/stats?days=${String(days)}`),

  getIssueStats: (issueId: string, days = 14) =>
    request<IssueStats>(`/api/issues/${issueId}/stats?days=${String(days)}`),

  // v0.4 item 2. Callers must treat any failure (404 for an unknown/deleted release, or
  // anything else) as "no maps to show" — see Releases.tsx's ReleaseMapsCount.
  getReleaseSymbols: (releaseId: string) =>
    request<{ maps: ReleaseSymbolMap[] }>(`/api/releases/${releaseId}/symbols`),
};
