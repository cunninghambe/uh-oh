// The narrow backend contract that both the in-process (server) and HTTP
// (stdio) implementations satisfy. The tool registry in tools.ts is written
// ONCE against this interface, so the same tools run whether they talk to the
// database directly or to a remote uh-oh server over its /api/*.
//
// All shapes here are plain data (DTOs) that mirror the server's DB rows and
// /api/* JSON responses. This package must never import from @uh-oh/server
// (the server depends on this package, not the other way around).

/** A project row / `/api/projects` entry. */
export interface Project {
  id: string;
  name: string;
  slug: string;
  publicKey: string;
  webhookUrl: string | null;
  alertDedupeMinutes: number;
  createdAt: number;
}

/** An issue row / `/api/issues/:id` `issue`. */
export interface Issue {
  id: string;
  projectId: string;
  fingerprint: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  status: 'open' | 'resolved' | 'ignored';
  lastAlertedAt: number | null;
}

/** An event row. `payload` is the full EventEnvelope JSON string. */
export interface EventRecord {
  id: string;
  projectId: string;
  issueId: string;
  releaseId: string | null;
  fingerprint: string;
  level: string;
  platform: string;
  payload: string;
  receivedAt: number;
  deviceInfo: string;
  userInfo: string | null;
}

/** A breadcrumb row. `data` is a JSON string or null. */
export interface BreadcrumbRecord {
  eventId: string;
  idx: number;
  ts: number;
  category: string;
  level: string;
  message: string;
  data: string | null;
}

/** A release row / `/api/projects/:id/releases` entry. */
export interface Release {
  id: string;
  projectId: string;
  version: string;
  build: string;
  platform: string;
  mappingUploadedAt: number | null;
  sourcemapUploadedAt: number | null;
}

/** A single symbolicated frame (mirrors the server's symbolicate output). */
export interface ResolvedFrame {
  function?: string;
  module?: string;
  filename?: string;
  lineno?: number;
  status: string;
}

export type IssueStatus = 'open' | 'resolved' | 'ignored';
export type IssueSort = 'lastSeen' | 'eventCount' | 'firstSeen';

export interface ListIssuesInput {
  projectId: string;
  status?: IssueStatus;
  sort?: IssueSort;
  limit: number;
  offset: number;
}

export interface UpdateProjectInput {
  projectId: string;
  name?: string;
  webhookUrl?: string | null;
  alertDedupeMinutes?: number;
}

export interface IssueDetail {
  issue: Issue;
  latestEvent: EventRecord | null;
  frames: ResolvedFrame[];
  breadcrumbs: BreadcrumbRecord[];
}

export interface EventDetail {
  event: EventRecord;
  breadcrumbs: BreadcrumbRecord[];
  frames?: ResolvedFrame[];
}

export interface HealthReport {
  ok: boolean;
  /** True when the /metrics subset below was actually available. */
  metricsAvailable: boolean;
  eventsIngested: number;
  issuesNew: number;
  webhookFailures: number;
}

/**
 * Thrown by a backend when the underlying operation fails in a way that should
 * surface to the MCP client as a tool error (a 4xx from the API, an SSRF-
 * rejected webhook URL, a network/timeout failure). The tool layer catches
 * these and returns an `isError` result rather than throwing.
 */
export class BackendError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = opts.code ?? 'backend_error';
    this.status = opts.status;
  }
}

/**
 * The single backend contract. Methods reject with {@link BackendError} for
 * expected failures (not-found, validation, timeout). Slug→id resolution for
 * the `project` parameter of list_issues / list_releases is done in the tool
 * layer via {@link UhOhBackend.listProjects}, so implementations only ever
 * receive a concrete `projectId`.
 */
export interface UhOhBackend {
  listProjects(): Promise<Project[]>;
  createProject(input: { name: string }): Promise<Project>;
  updateProject(input: UpdateProjectInput): Promise<Project>;
  listIssues(input: ListIssuesInput): Promise<{ issues: Issue[]; total: number }>;
  getIssue(input: { issueId: string }): Promise<IssueDetail | null>;
  listIssueEvents(input: {
    issueId: string;
    page: number;
    limit: number;
  }): Promise<{ events: EventRecord[]; total: number }>;
  getEvent(input: { eventId: string; symbolicate: boolean }): Promise<EventDetail | null>;
  setIssueStatus(input: { issueId: string; status: IssueStatus }): Promise<Issue | null>;
  listReleases(input: { projectId: string }): Promise<Release[]>;
  getHealth(): Promise<HealthReport>;
}
