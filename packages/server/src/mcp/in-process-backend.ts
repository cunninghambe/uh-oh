// InProcessBackend — the UhOhBackend implementation used by the server's own
// /mcp endpoint. It runs the tool operations directly against the DB repos and
// symbolication modules (no HTTP hop back to ourselves), and it mirrors the
// exact same validation the /api/* routes apply (notably the SSRF check on a
// webhook URL), so behaviour is identical whether a tool is invoked in-process
// or over the HTTP backend.

import {
  BackendError,
  type EventDetail,
  type EventRecord,
  type HealthReport,
  type Issue,
  type IssueDetail,
  type IssueStatus,
  type ListIssuesInput,
  type Project,
  type Release,
  type UhOhBackend,
  type UpdateProjectInput,
} from '@uh-oh/mcp';

import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getEvent, getLatestEventForIssue, listEventsForIssue } from '../db/repos/events.js';
import { getIssue, listIssues, setIssueStatus } from '../db/repos/issues.js';
import { createProject, listProjects, updateProject } from '../db/repos/projects.js';
import { listReleasesForProject } from '../db/repos/releases.js';
import type { Db } from '../db/index.js';
import type { ProjectRow } from '../db/schema.js';
import { registry } from '../metrics/registry.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { validateWebhookUrl } from '../webhooks/url-guard.js';
import { parseMetricsSubset } from '@uh-oh/mcp';

export class InProcessBackend implements UhOhBackend {
  constructor(private readonly db: Db) {}

  listProjects(): Promise<Project[]> {
    return Promise.resolve(listProjects(this.db));
  }

  createProject(input: { name: string }): Promise<Project> {
    return Promise.resolve(createProject(this.db, { name: input.name }));
  }

  updateProject(input: UpdateProjectInput): Promise<Project> {
    const patch: Partial<Pick<ProjectRow, 'webhookUrl' | 'alertDedupeMinutes' | 'name'>> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.alertDedupeMinutes !== undefined) patch.alertDedupeMinutes = input.alertDedupeMinutes;
    if (input.webhookUrl !== undefined) {
      if (input.webhookUrl === null) {
        patch.webhookUrl = null;
      } else if (!validateWebhookUrl(input.webhookUrl).ok) {
        // Same SSRF rejection the PATCH /api/projects/:id route returns as a 400.
        throw new BackendError('webhook URL rejected (loopback/private/metadata or bad scheme)', {
          code: 'invalid_webhookUrl',
          status: 400,
        });
      } else {
        patch.webhookUrl = input.webhookUrl;
      }
    }
    const updated = updateProject(this.db, input.projectId, patch);
    if (!updated) {
      throw new BackendError('project not found', { code: 'not_found', status: 404 });
    }
    return Promise.resolve(updated);
  }

  listIssues(input: ListIssuesInput): Promise<{ issues: Issue[]; total: number }> {
    const { rows, total } = listIssues(this.db, {
      projectId: input.projectId,
      limit: input.limit,
      offset: input.offset,
      ...(input.status ? { status: input.status } : {}),
      ...(input.sort ? { sort: input.sort } : {}),
    });
    return Promise.resolve({ issues: rows, total });
  }

  async getIssue(input: { issueId: string }): Promise<IssueDetail | null> {
    const issue = getIssue(this.db, input.issueId);
    if (!issue) return null;
    const latestEvent = getLatestEventForIssue(this.db, issue.id);
    const breadcrumbs = latestEvent ? listBreadcrumbs(this.db, latestEvent.id) : [];
    const frames = latestEvent ? await symbolicateEvent(this.db, latestEvent.id) : [];
    return { issue, latestEvent, frames, breadcrumbs };
  }

  listIssueEvents(input: {
    issueId: string;
    page: number;
    limit: number;
  }): Promise<{ events: EventRecord[]; total: number }> {
    // Mirror the GET /api/issues/:id/events route, which 404s on an unknown
    // issue rather than returning an empty list — so both backends behave the
    // same for a missing issue.
    if (!getIssue(this.db, input.issueId)) {
      throw new BackendError('issue not found', { code: 'not_found', status: 404 });
    }
    const offset = (input.page - 1) * input.limit;
    const { rows, total } = listEventsForIssue(this.db, input.issueId, {
      limit: input.limit,
      offset,
    });
    return Promise.resolve({ events: rows, total });
  }

  async getEvent(input: { eventId: string; symbolicate: boolean }): Promise<EventDetail | null> {
    const event = getEvent(this.db, input.eventId);
    if (!event) return null;
    const breadcrumbs = listBreadcrumbs(this.db, event.id);
    if (input.symbolicate) {
      const frames = await symbolicateEvent(this.db, event.id);
      return { event, breadcrumbs, frames };
    }
    return { event, breadcrumbs };
  }

  setIssueStatus(input: { issueId: string; status: IssueStatus }): Promise<Issue | null> {
    return Promise.resolve(setIssueStatus(this.db, input.issueId, input.status));
  }

  listReleases(input: { projectId: string }): Promise<Release[]> {
    return Promise.resolve(listReleasesForProject(this.db, input.projectId));
  }

  async getHealth(): Promise<HealthReport> {
    // In-process: the process answering this call is by definition up. Read the
    // same counters /metrics exposes and parse them with the shared parser so
    // the surfaced subset is identical to the HTTP backend's.
    const text = await registry.metrics();
    const subset = parseMetricsSubset(text);
    return { ok: true, metricsAvailable: true, ...subset };
  }
}
