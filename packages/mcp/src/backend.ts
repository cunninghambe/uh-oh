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
  // 'regressed' is system-set (a resolved issue that received a new event; see
  // §18). 'merged' (v0.9 §24) is a system-set terminal status — an issue merged
  // into another. Both are surfaced here but are not user-settable via
  // set_issue_status.
  status: 'open' | 'resolved' | 'ignored' | 'regressed' | 'merged';
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
  /** v0.8 §23: the deploy-time commit, when the uploader/CLI resolved one. */
  commitSha: string | null;
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

// User-settable statuses (the `set_issue_status` input). 'regressed' and
// 'merged' are system-set and intentionally excluded here.
export type IssueStatus = 'open' | 'resolved' | 'ignored';
// Statuses accepted by the `list_issues` filter — adds the system-set
// 'regressed' and (v0.9 §24) the terminal 'merged' status, mirroring the REST
// filter exactly (the ONLY way to surface merged issues; the default listing
// hides them).
export type IssueFilterStatus = IssueStatus | 'regressed' | 'merged';
export type IssueSort = 'lastSeen' | 'eventCount' | 'firstSeen';

export interface ListIssuesInput {
  projectId: string;
  status?: IssueFilterStatus;
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

// ── v0.5 impact / bundle / top-issues / monitors DTOs ─────────────────────────
// Plain data mirroring the server's /api/* JSON (this package never imports from
// @uh-oh/server). Timestamps are epoch-ms, matching the REST payloads and the
// server-side size-bounding of the bundle.

/** CONTRACT I — issue impact roll-up. */
export interface IssueImpact {
  /** Distinct user ids across the issue's events; null when none carry a user. */
  distinctUsers: number | null;
  topDevices: Array<{ model: string; events: number }>;
  topOs: Array<{ os: string; events: number }>;
  releases: Array<{ release: string; events: number }>;
  platforms: Array<{ platform: string; events: number }>;
}

/** A resolved frame in a bundle — a {@link ResolvedFrame} plus optional context. */
export interface BundleFrame extends ResolvedFrame {
  context?: { pre: string[]; line: string; post: string[] };
}

export interface BundleBreadcrumb {
  ts: number;
  category: string;
  level: string;
  message: string;
  data?: unknown;
}

export interface BundleLatestEvent {
  id: string;
  receivedAt: number;
  level: string;
  platform: string;
  /** "version+build", or null. */
  release: string | null;
  exception: { type?: string; value?: string; mechanism?: string } | null;
  frames: BundleFrame[];
  breadcrumbs: BundleBreadcrumb[];
}

export interface BundleRecentEvent {
  id: string;
  receivedAt: number;
  level: string;
  platform: string;
  release: string | null;
}

/** Symbol availability for the latest event's release. */
export interface BundleSymbols {
  releaseId: string | null;
  platform: string | null;
  mappingUploaded: boolean;
  sourcemapUploaded: boolean;
  maps: { web: number; node: number };
}

/**
 * CONTRACT B — everything an agent needs to fix a crash in one call. Serialized
 * form is hard-capped ~64KB by the server; `truncated` flags what was dropped
 * (context lines first, then breadcrumbs, then annotations oldest-first — the
 * v0.8 §23 order, annotations being the most protected content) to fit.
 */
export interface IssueBundle {
  project: { id: string; name: string; slug: string; repoUrl: string | null };
  issue: {
    id: string;
    title: string;
    fingerprint: string;
    platform: string | null;
    status: string;
    firstSeen: number;
    lastSeen: number;
    eventCount: number;
  };
  impact: IssueImpact;
  latestEvent: BundleLatestEvent | null;
  recentEvents: BundleRecentEvent[];
  symbols: BundleSymbols | null;
  /** The investigation record (§23): last 10 annotations newest-first, and
   *  every fix attempt newest-first. */
  annotations: Annotation[];
  fixAttempts: FixAttempt[];
  truncated: { context: boolean; breadcrumbs: boolean; annotations: boolean };
}

// ── v0.8 agent-loop DTOs (§23) ─────────────────────────────────────────────────
// Investigation record (annotations, fix attempts) + fleet-wide similarity, all
// plain data mirroring the server's `/api/*` JSON (this package never imports
// from @uh-oh/server). Timestamps are epoch-ms, matching the REST payloads.

/**
 * Annotation kinds. 'system' is written by the server only (the audit trail of
 * every fix-attempt state transition) — a client (the annotate_issue tool) may
 * only ever set one of the other four.
 */
export type AnnotationKind = 'note' | 'root_cause' | 'fix_plan' | 'verification' | 'system';
/** The kinds `annotate_issue` may set. */
export type ClientAnnotationKind = Exclude<AnnotationKind, 'system'>;

/** An issue annotation (issue detail, bundle, annotate_issue's response). */
export interface Annotation {
  id: string;
  issueId: string;
  author: string;
  kind: AnnotationKind;
  body: string;
  createdAt: number;
}

export type FixAttemptState = 'filed' | 'deployed' | 'verified' | 'failed';
/** States `record_fix_attempt` may transition a fix attempt to. 'filed' is the
 *  implicit creation state (never a transition target); 'verified' is system-set
 *  by the hourly verify sweep and is rejected in the tool's input schema. */
export type ClientFixAttemptTransition = Extract<FixAttemptState, 'deployed' | 'failed'>;

/** A tracked fix attempt (issue detail, bundle, record_fix_attempt's response). */
export interface FixAttempt {
  id: string;
  issueId: string;
  prUrl: string;
  commitSha: string | null;
  state: FixAttemptState;
  createdAt: number;
  deployedAt: number | null;
  updatedAt: number;
}

/** A fleet-wide issue sharing an exception-type prefix (list_similar_issues). */
export interface SimilarIssue {
  issue: {
    id: string;
    projectId: string;
    projectSlug: string;
    title: string;
    status: string;
    platform: string | null;
    lastSeen: number;
    eventCount: number;
  };
  fixAttempts: FixAttempt[];
  annotationCount: number;
}

/** A ranked open/regressed issue across all projects (list_top_issues). */
export interface TopIssue {
  issueId: string;
  title: string;
  status: string;
  platform: string | null;
  projectId: string;
  projectSlug: string;
  projectName: string;
  /** Event count within the requested window. */
  windowEvents: number;
  /** All-time event count. */
  eventCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ListTopIssuesInput {
  limit: number;
  days: number;
}

/**
 * A monitor with a computed `overdue` flag (list_monitors). `overdue` is
 * meaningful only for check-in monitors; http monitors always report `false`
 * (their health rides `status` instead). `url`/`lastProbeAt`/`lastProbeStatus`
 * are null for check-in monitors, which are never probed (v0.9 §24).
 */
export interface Monitor {
  id: string;
  projectId: string;
  projectSlug: string;
  slug: string;
  name: string | null;
  intervalMinutes: number;
  graceMinutes: number;
  status: string;
  lastCheckInAt: number | null;
  createdAt: number;
  overdue: boolean;
  kind: 'checkin' | 'http';
  url: string | null;
  lastProbeAt: number | null;
  /** The probe's HTTP status code, or null if never probed. */
  lastProbeStatus: number | null;
}

export interface ListMonitorsInput {
  /** Concrete project id (resolved in the tool layer); omit for all projects. */
  projectId?: string;
}

/**
 * CONTRACT U-API — privacy-first usage analytics summary for a project over a
 * day window. `visitors` are distinct daily-rotating visitor hashes, so a
 * visitor returning across days is counted once per day (an intentional privacy
 * over-count). Raw IP / User-Agent are never part of this — they were never
 * stored.
 */
export interface UsageSummary {
  days: Array<{ date: string; pageviews: number; visitors: number; events: number }>;
  topPages: Array<{ path: string; pageviews: number; visitors: number }>;
  topReferrers: Array<{ referrer: string; pageviews: number }>;
  topEvents: Array<{ name: string; count: number }>;
  totals: { pageviews: number; visitors: number; events: number };
}

// ── v0.9 release health (§24) ───────────────────────────────────────────────
// Plain data mirroring `/api/projects/:id/release-health` (this package never
// imports from @uh-oh/server). Timestamps are epoch-ms, matching the REST
// payload.

/** A single release's crash volume vs. attributed usage pageviews. */
export interface ReleaseHealthEntry {
  id: string;
  version: string;
  build: string;
  platform: string;
  commitSha: string | null;
  events: number;
  fatalEvents: number;
  distinctIssues: number;
  firstEventAt: number;
  lastEventAt: number;
  pageviews: number;
  /** events / pageviews × 1000, 1 decimal; null when pageviews is 0. */
  crashesPer1kPageviews: number | null;
}

/** The same five numeric fields as {@link ReleaseHealthEntry}, project-wide. */
export interface ReleaseHealthTotals {
  events: number;
  fatalEvents: number;
  distinctIssues: number;
  pageviews: number;
  crashesPer1kPageviews: number | null;
}

/** `GET /api/projects/:id/release-health` (get_release_health). */
export interface ReleaseHealth {
  /** Every release with ≥1 event in the window, ≤20, ordered lastEventAt desc. */
  releases: ReleaseHealthEntry[];
  totals: ReleaseHealthTotals;
}

export interface IssueDetail {
  issue: Issue;
  latestEvent: EventRecord | null;
  frames: ResolvedFrame[];
  breadcrumbs: BreadcrumbRecord[];
  /** v0.9 §24: the target issue id when `issue.status` is 'merged', else null. */
  mergedInto: string | null;
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
  /** CONTRACT B — the full fix-dossier bundle for an issue (null if unknown). */
  getIssueBundle(input: { issueId: string }): Promise<IssueBundle | null>;
  /** Open/regressed issues across all projects, ranked by windowed volume. */
  listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]>;
  /** Check-in monitors across projects (or one), with computed `overdue`. */
  listMonitors(input: ListMonitorsInput): Promise<Monitor[]>;
  /** CONTRACT U-API — usage analytics summary for a project over `days`. */
  getUsageSummary(input: { projectId: string; days: number }): Promise<UsageSummary>;
  /** v0.9 §24 — per-release crash health vs. attributed usage pageviews. */
  getReleaseHealth(input: { projectId: string; days: number }): Promise<ReleaseHealth>;

  // ── v0.8 agent-loop (§23) ──────────────────────────────────────────────────

  /** Fleet-wide issues sharing this issue's exception-type prefix, ranked by
   *  has-verified-fix, annotation count, then recency (null if the issue is
   *  unknown). */
  listSimilarIssues(input: { issueId: string }): Promise<SimilarIssue[] | null>;
  /** Add an investigation note to an issue. Rejects with `not_found` for an
   *  unknown issue. */
  createAnnotation(input: {
    issueId: string;
    body: string;
    kind?: ClientAnnotationKind;
    author?: string;
  }): Promise<Annotation>;
  /** Upsert a fix attempt by (issue, prUrl) into state `filed` (or update its
   *  commitSha on an existing row). Rejects with `not_found` for an unknown
   *  issue. */
  upsertFixAttempt(input: {
    issueId: string;
    prUrl: string;
    commitSha?: string;
  }): Promise<FixAttempt>;
  /** Transition a fix attempt to `deployed` or `failed`. Rejects with
   *  `not_found` for an unknown attempt and `invalid_transition` (400) for a
   *  transition the state machine does not allow. */
  transitionFixAttempt(input: {
    fixAttemptId: string;
    state: ClientFixAttemptTransition;
  }): Promise<FixAttempt>;
}
