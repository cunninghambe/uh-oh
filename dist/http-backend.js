// HttpBackend — talks to a remote uh-oh server's public HTTP surface. Used by
// the stdio bin so the owner can triage crashes from any machine that can reach
// the server. Logs in with the admin password, caches the JWT, transparently
// re-logs-in ONCE on a 401 (expired/rotated token), and bounds every request
// with a 10s AbortController timeout.
//
// Never writes to stdout — logging goes through the injected `log` sink, which
// the stdio bin points at stderr so the MCP framing on stdout stays pristine.
import { BackendError, } from './backend.js';
import { parseMetricsSubset } from './metrics.js';
const DEFAULT_TIMEOUT_MS = 10_000;
export class HttpBackend {
    base;
    adminPassword;
    fetchImpl;
    timeoutMs;
    log;
    token = null;
    constructor(config) {
        this.base = config.serverUrl.replace(/\/+$/, '');
        this.adminPassword = config.adminPassword;
        this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
        this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.log = config.log ?? (() => undefined);
    }
    // ── low-level fetch with timeout ────────────────────────────────────────────
    async fetchWithTimeout(url, init) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await this.fetchImpl(url, { ...init, signal: controller.signal });
        }
        catch (err) {
            if (controller.signal.aborted) {
                throw new BackendError(`request to ${url} timed out after ${this.timeoutMs}ms`, {
                    code: 'timeout',
                });
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new BackendError(`request to ${url} failed: ${message}`, { code: 'network' });
        }
        finally {
            clearTimeout(timer);
        }
    }
    // ── auth ────────────────────────────────────────────────────────────────────
    async login() {
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
        const body = (await res.json());
        if (typeof body.token !== 'string' || body.token.length === 0) {
            throw new BackendError('login response missing token', { code: 'login_failed' });
        }
        this.log(`authenticated to ${this.base}`);
        this.token = body.token;
        return body.token;
    }
    /** Authenticated request against /api/*, re-logging-in once on a 401. */
    async api(method, path, body) {
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
    send(method, path, token, body) {
        const headers = { authorization: `Bearer ${token}` };
        const init = { method, headers };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        return this.fetchWithTimeout(`${this.base}${path}`, init);
    }
    async parse(res) {
        if (res.status === 204)
            return null;
        const text = await res.text();
        let json = null;
        if (text.length > 0) {
            try {
                json = JSON.parse(text);
            }
            catch {
                json = null;
            }
        }
        if (!res.ok) {
            const rec = (json ?? {});
            const code = typeof rec.error === 'string' ? rec.error : `http_${res.status}`;
            const message = typeof rec.message === 'string'
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
    async apiOrNull(method, path, body) {
        try {
            return await this.api(method, path, body);
        }
        catch (err) {
            if (err instanceof BackendError && err.status === 404)
                return null;
            throw err;
        }
    }
    // ── UhOhBackend ─────────────────────────────────────────────────────────────
    async listProjects() {
        const body = (await this.api('GET', '/api/projects'));
        return body.projects;
    }
    async createProject(input) {
        const body = (await this.api('POST', '/api/projects', { name: input.name }));
        return body.project;
    }
    async updateProject(input) {
        const patch = {};
        if (input.name !== undefined)
            patch['name'] = input.name;
        if (input.webhookUrl !== undefined)
            patch['webhookUrl'] = input.webhookUrl;
        if (input.alertDedupeMinutes !== undefined)
            patch['alertDedupeMinutes'] = input.alertDedupeMinutes;
        const body = (await this.api('PATCH', `/api/projects/${encodeURIComponent(input.projectId)}`, patch));
        return body.project;
    }
    async listIssues(input) {
        const qs = new URLSearchParams();
        if (input.status)
            qs.set('status', input.status);
        if (input.sort)
            qs.set('sort', input.sort);
        qs.set('limit', String(input.limit));
        qs.set('offset', String(input.offset));
        const body = (await this.api('GET', `/api/projects/${encodeURIComponent(input.projectId)}/issues?${qs.toString()}`));
        return { issues: body.issues, total: body.total };
    }
    async getIssue(input) {
        const body = (await this.apiOrNull('GET', `/api/issues/${encodeURIComponent(input.issueId)}`));
        if (!body)
            return null;
        let frames = [];
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
    async listIssueEvents(input) {
        const qs = new URLSearchParams({ page: String(input.page), limit: String(input.limit) });
        const body = (await this.api('GET', `/api/issues/${encodeURIComponent(input.issueId)}/events?${qs.toString()}`));
        return { events: body.events, total: body.total };
    }
    async getEvent(input) {
        const qs = new URLSearchParams({ symbolicate: input.symbolicate ? 'true' : 'false' });
        const body = (await this.apiOrNull('GET', `/api/events/${encodeURIComponent(input.eventId)}?${qs.toString()}`));
        if (!body)
            return null;
        return {
            event: body.event,
            breadcrumbs: body.breadcrumbs,
            ...(body.frames ? { frames: body.frames } : {}),
        };
    }
    async setIssueStatus(input) {
        const body = (await this.apiOrNull('PATCH', `/api/issues/${encodeURIComponent(input.issueId)}`, { status: input.status }));
        return body ? body.issue : null;
    }
    async listReleases(input) {
        const body = (await this.api('GET', `/api/projects/${encodeURIComponent(input.projectId)}/releases`));
        return body.releases;
    }
    async getIssueBundle(input) {
        return (await this.apiOrNull('GET', `/api/issues/${encodeURIComponent(input.issueId)}/bundle`));
    }
    async listTopIssues(input) {
        const qs = new URLSearchParams({ limit: String(input.limit), days: String(input.days) });
        const body = (await this.api('GET', `/api/top-issues?${qs.toString()}`));
        return body.issues;
    }
    async listMonitors(input) {
        // One project → its monitors route directly. No project → fan out across all
        // projects (mirrors how getIssue composes getEvent). The per-project route
        // returns rows already carrying projectSlug + overdue.
        if (input.projectId !== undefined) {
            const body = (await this.api('GET', `/api/projects/${encodeURIComponent(input.projectId)}/monitors`));
            return body.monitors;
        }
        const projects = await this.listProjects();
        const all = [];
        for (const p of projects) {
            const body = (await this.api('GET', `/api/projects/${encodeURIComponent(p.id)}/monitors`));
            all.push(...body.monitors);
        }
        return all;
    }
    async getHealth() {
        let ok = false;
        try {
            const res = await this.fetchWithTimeout(`${this.base}/healthz`, { method: 'GET' });
            ok = res.ok;
            await res.text();
        }
        catch (err) {
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
        }
        catch (err) {
            this.log(`metrics probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { ok, metricsAvailable, ...subset };
    }
}
//# sourceMappingURL=http-backend.js.map