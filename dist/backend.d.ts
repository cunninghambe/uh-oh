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
    status: 'open' | 'resolved' | 'ignored' | 'regressed';
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
export type IssueFilterStatus = IssueStatus | 'regressed';
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
/** CONTRACT I — issue impact roll-up. */
export interface IssueImpact {
    /** Distinct user ids across the issue's events; null when none carry a user. */
    distinctUsers: number | null;
    topDevices: Array<{
        model: string;
        events: number;
    }>;
    topOs: Array<{
        os: string;
        events: number;
    }>;
    releases: Array<{
        release: string;
        events: number;
    }>;
    platforms: Array<{
        platform: string;
        events: number;
    }>;
}
/** A resolved frame in a bundle — a {@link ResolvedFrame} plus optional context. */
export interface BundleFrame extends ResolvedFrame {
    context?: {
        pre: string[];
        line: string;
        post: string[];
    };
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
    exception: {
        type?: string;
        value?: string;
        mechanism?: string;
    } | null;
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
    maps: {
        web: number;
        node: number;
    };
}
/**
 * CONTRACT B — everything an agent needs to fix a crash in one call. Serialized
 * form is hard-capped ~64KB by the server; `truncated` flags what was dropped
 * (context lines first, then breadcrumbs) to fit.
 */
export interface IssueBundle {
    project: {
        id: string;
        name: string;
        slug: string;
    };
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
    truncated: {
        context: boolean;
        breadcrumbs: boolean;
    };
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
/** A check-in monitor with a computed `overdue` flag (list_monitors). */
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
}
export interface ListMonitorsInput {
    /** Concrete project id (resolved in the tool layer); omit for all projects. */
    projectId?: string;
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
export declare class BackendError extends Error {
    readonly code: string;
    readonly status: number | undefined;
    constructor(message: string, opts?: {
        code?: string;
        status?: number;
    });
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
    createProject(input: {
        name: string;
    }): Promise<Project>;
    updateProject(input: UpdateProjectInput): Promise<Project>;
    listIssues(input: ListIssuesInput): Promise<{
        issues: Issue[];
        total: number;
    }>;
    getIssue(input: {
        issueId: string;
    }): Promise<IssueDetail | null>;
    listIssueEvents(input: {
        issueId: string;
        page: number;
        limit: number;
    }): Promise<{
        events: EventRecord[];
        total: number;
    }>;
    getEvent(input: {
        eventId: string;
        symbolicate: boolean;
    }): Promise<EventDetail | null>;
    setIssueStatus(input: {
        issueId: string;
        status: IssueStatus;
    }): Promise<Issue | null>;
    listReleases(input: {
        projectId: string;
    }): Promise<Release[]>;
    getHealth(): Promise<HealthReport>;
    /** CONTRACT B — the full fix-dossier bundle for an issue (null if unknown). */
    getIssueBundle(input: {
        issueId: string;
    }): Promise<IssueBundle | null>;
    /** Open/regressed issues across all projects, ranked by windowed volume. */
    listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]>;
    /** Check-in monitors across projects (or one), with computed `overdue`. */
    listMonitors(input: ListMonitorsInput): Promise<Monitor[]>;
}
//# sourceMappingURL=backend.d.ts.map