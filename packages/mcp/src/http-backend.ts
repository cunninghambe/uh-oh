// HttpBackend — talks to a remote uh-oh server's public HTTP surface. Used by
// the stdio bin so the owner can triage crashes from any machine that can reach
// the server. Logs in with the admin password, caches the JWT, transparently
// re-logs-in ONCE on a 401 (expired/rotated token), and bounds every request
// with a 10s AbortController timeout.
//
// Never writes to stdout — logging goes through the injected `log` sink, which
// the stdio bin points at stderr so the MCP framing on stdout stays pristine.

import {
  BackendError,
  type BreadcrumbRecord,
  type EventDetail,
  type EventRecord,
  type HealthReport,
  type Issue,
  type IssueBundle,
  type IssueDetail,
  type IssueStatus,
  type ListIssuesInput,
  type ListMonitorsInput,
  type ListTopIssuesInput,
  type Monitor,
  type Project,
  type Release,
  type ResolvedFrame,
  type TopIssue,
  type UhOhBackend,
  type UpdateProjectInput,
} from './backend.js';
import { parseMetricsSubset } from './metrics.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpBackendConfig {
  serverUrl: string;
  adminPassword: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Diagnostic sink; MUST NOT be stdout in the stdio bin. Default: no-op. */
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpBackend implements UhOhBackend {
  private readonly base: string;
  private readonly adminPassword: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private token: string | null = null;

  constructor(config: HttpBackendConfig) {
    this.base = config.serverUrl.replace(/\/+$/, '');
    this.adminPassword = config.adminPassword;
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = config.log ?? (() => undefined);
  }

  // ── low-level fetch with timeout ────────────────────────────────────────────

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BackendError(`request to ${url} timed out after ${this.timeoutMs}ms`, {
          code: 'timeout',
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new BackendError(`request to ${url} failed: ${message}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── auth ────────────────────────────────────────────────────────────────────

  private async login(): Promise<string> {
    const res = await this.fetchWithTimeout(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.adminPassword }),
    });
    if (res.status === 429) {
      throw new BackendError('login rate-limited by server', { code: 'rate_limited', status: 429 });
    }
    if (!res.ok) {
      throw new BackendError('login failed — check UH_OH_ADMIN_PASSWORD', {
        code: 'login_failed',
        status: res.status,
      });
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new BackendError('login response missing token', { code: 'login_failed' });
    }
    this.log(`authenticated to ${this.base}`);
    this.token = body.token;
    return body.token;
  }

  /** Authenticated request against /api/*, re-logging-in once on a 401. */
  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    let token = this.token ?? (await this.login());
    let res = await this.send(method, path, token, body);
    if (res.status === 401) {
      this.log('token rejected (401); re-authenticating once');
      this.token = null;
      token = await this.login();
      res = await this.send(method, path, token, body);
    }
    return this.parse(res);
  }

  private send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.fetchWithTimeout(`${this.base}${path}`, init);
  }

  private async parse(res: Response): Promise<unknown> {
    if (res.status === 204) return null;
    const text = await res.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const rec = (json ?? {}) as { error?: unknown; message?: unknown };
      const code = typeof rec.error === 'string' ? rec.error : `http_${res.status}`;
      const message =
        typeof rec.message === 'string'
          ? rec.message
          : typeof rec.error === 'string'
            ? rec.error
            : `request failed with status ${res.status}`;
      throw new BackendError(message, { code, status: res.status });
    }
    return json;
  }

  /** Run an /api request, mapping a 404 to null (for the get/set methods whose
   *  interface returns null on not-found). */
  private async apiOrNull(method: string, path: string, body?: unknown): Promise<unknown> {
    try {
      return await this.api(method, path, body);
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return null;
      throw err;
    }
  }

  // ── UhOhBackend ─────────────────────────────────────────────────────────────

  async listProjects(): Promise<Project[]> {
    const body = (await this.api('GET', '/api/projects')) as { projects: Project[] };
    return body.projects;
  }

  async createProject(input: { name: string }): Promise<Project> {
    const body = (await this.api('POST', '/api/projects', { name: input.name })) as {
      project: Project;
    };
    return body.project;
  }

  async updateProject(input: UpdateProjectInput): Promise<Project> {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch['name'] = input.name;
    if (input.webhookUrl !== undefined) patch['webhookUrl'] = input.webhookUrl;
    if (input.alertDedupeMinutes !== undefined)
      patch['alertDedupeMinutes'] = input.alertDedupeMinutes;
    const body = (await this.api(
      'PATCH',
      `/api/projects/${encodeURIComponent(input.projectId)}`,
      patch,
    )) as { project: Project };
    return body.project;
  }

  async listIssues(input: ListIssuesInput): Promise<{ issues: Issue[]; total: number }> {
    const qs = new URLSearchParams();
    if (input.status) qs.set('status', input.status);
    if (input.sort) qs.set('sort', input.sort);
    qs.set('limit', String(input.limit));
    qs.set('offset', String(input.offset));
    const body = (await this.api(
      'GET',
      `/api/projects/${encodeURIComponent(input.projectId)}/issues?${qs.toString()}`,
    )) as { issues: Issue[]; total: number };
    return { issues: body.issues, total: body.total };
  }

  async getIssue(input: { issueId: string }): Promise<IssueDetail | null> {
    const body = (await this.apiOrNull(
      'GET',
      `/api/issues/${encodeURIComponent(input.issueId)}`,
    )) as {
      issue: Issue;
      latestEvent: EventRecord | null;
      breadcrumbs: BreadcrumbRecord[];
    } | null;
    if (!body) return null;

    let frames: ResolvedFrame[] = [];
    if (body.latestEvent) {
      const detail = await this.getEvent({ eventId: body.latestEvent.id, symbolicate: true });
      frames = detail?.frames ?? [];
    }
    return {
      issue: body.issue,
      latestEvent: body.latestEvent,
      frames,
      breadcrumbs: body.breadcrumbs,
    };
  }

  async listIssueEvents(input: {
    issueId: string;
    page: number;
    limit: number;
  }): Promise<{ events: EventRecord[]; total: number }> {
    const qs = new URLSearchParams({ page: String(input.page), limit: String(input.limit) });
    const body = (await this.api(
      'GET',
      `/api/issues/${encodeURIComponent(input.issueId)}/events?${qs.toString()}`,
    )) as { events: EventRecord[]; total: number };
    return { events: body.events, total: body.total };
  }

  async getEvent(input: { eventId: string; symbolicate: boolean }): Promise<EventDetail | null> {
    const qs = new URLSearchParams({ symbolicate: input.symbolicate ? 'true' : 'false' });
    const body = (await this.apiOrNull(
      'GET',
      `/api/events/${encodeURIComponent(input.eventId)}?${qs.toString()}`,
    )) as { event: EventRecord; breadcrumbs: BreadcrumbRecord[]; frames?: ResolvedFrame[] } | null;
    if (!body) return null;
    return {
      event: body.event,
      breadcrumbs: body.breadcrumbs,
      ...(body.frames ? { frames: body.frames } : {}),
    };
  }

  async setIssueStatus(input: { issueId: string; status: IssueStatus }): Promise<Issue | null> {
    const body = (await this.apiOrNull(
      'PATCH',
      `/api/issues/${encodeURIComponent(input.issueId)}`,
      { status: input.status },
    )) as { issue: Issue } | null;
    return body ? body.issue : null;
  }

  async listReleases(input: { projectId: string }): Promise<Release[]> {
    const body = (await this.api(
      'GET',
      `/api/projects/${encodeURIComponent(input.projectId)}/releases`,
    )) as { releases: Release[] };
    return body.releases;
  }

  async getIssueBundle(input: { issueId: string }): Promise<IssueBundle | null> {
    return (await this.apiOrNull(
      'GET',
      `/api/issues/${encodeURIComponent(input.issueId)}/bundle`,
    )) as IssueBundle | null;
  }

  async listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]> {
    const qs = new URLSearchParams({ limit: String(input.limit), days: String(input.days) });
    const body = (await this.api('GET', `/api/top-issues?${qs.toString()}`)) as {
      issues: TopIssue[];
    };
    return body.issues;
  }

  async listMonitors(input: ListMonitorsInput): Promise<Monitor[]> {
    // One project → its monitors route directly. No project → fan out across all
    // projects (mirrors how getIssue composes getEvent). The per-project route
    // returns rows already carrying projectSlug + overdue.
    if (input.projectId !== undefined) {
      const body = (await this.api(
        'GET',
        `/api/projects/${encodeURIComponent(input.projectId)}/monitors`,
      )) as { monitors: Monitor[] };
      return body.monitors;
    }
    const projects = await this.listProjects();
    const all: Monitor[] = [];
    for (const p of projects) {
      const body = (await this.api(
        'GET',
        `/api/projects/${encodeURIComponent(p.id)}/monitors`,
      )) as { monitors: Monitor[] };
      all.push(...body.monitors);
    }
    return all;
  }

  async getHealth(): Promise<HealthReport> {
    let ok = false;
    try {
      const res = await this.fetchWithTimeout(`${this.base}/healthz`, { method: 'GET' });
      ok = res.ok;
      await res.text();
    } catch (err) {
      this.log(`healthz probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let metricsAvailable = false;
    let subset = { eventsIngested: 0, issuesNew: 0, webhookFailures: 0 };
    try {
      const res = await this.fetchWithTimeout(`${this.base}/metrics`, { method: 'GET' });
      const text = await res.text();
      if (res.ok) {
        subset = parseMetricsSubset(text);
        metricsAvailable = true;
      }
    } catch (err) {
      this.log(`metrics probe failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { ok, metricsAvailable, ...subset };
  }
}
