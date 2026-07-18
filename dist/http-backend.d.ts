import { type EventDetail, type EventRecord, type HealthReport, type Issue, type IssueBundle, type IssueDetail, type IssueStatus, type ListIssuesInput, type ListMonitorsInput, type ListTopIssuesInput, type Monitor, type Project, type Release, type TopIssue, type UhOhBackend, type UpdateProjectInput } from './backend.js';
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
export declare class HttpBackend implements UhOhBackend {
    private readonly base;
    private readonly adminPassword;
    private readonly fetchImpl;
    private readonly timeoutMs;
    private readonly log;
    private token;
    constructor(config: HttpBackendConfig);
    private fetchWithTimeout;
    private login;
    /** Authenticated request against /api/*, re-logging-in once on a 401. */
    private api;
    private send;
    private parse;
    /** Run an /api request, mapping a 404 to null (for the get/set methods whose
     *  interface returns null on not-found). */
    private apiOrNull;
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
    getIssueBundle(input: {
        issueId: string;
    }): Promise<IssueBundle | null>;
    listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]>;
    listMonitors(input: ListMonitorsInput): Promise<Monitor[]>;
    getHealth(): Promise<HealthReport>;
}
export {};
//# sourceMappingURL=http-backend.d.ts.map