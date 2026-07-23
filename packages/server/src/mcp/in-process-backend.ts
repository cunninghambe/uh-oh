// InProcessBackend — the UhOhBackend implementation used by the server's own
// /mcp endpoint. It runs the tool operations directly against the DB repos and
// symbolication modules (no HTTP hop back to ourselves), and it mirrors the
// exact same validation the /api/* routes apply (notably the SSRF check on a
// webhook URL), so behaviour is identical whether a tool is invoked in-process
// or over the HTTP backend.

import {
  BackendError,
  type Annotation,
  type ClientAnnotationKind,
  type ClientFixAttemptTransition,
  type EventDetail,
  type EventRecord,
  type FixAttempt,
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
  type SimilarIssue,
  type TopIssue,
  type UhOhBackend,
  type UpdateProjectInput,
  type UsageSummary,
} from '@uh-oh/mcp';

import { buildIssueBundle } from '../api/bundle.js';
import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getEvent, getLatestEventForIssue, listEventsForIssue } from '../db/repos/events.js';
import { getIssue, listIssues, setIssueStatus } from '../db/repos/issues.js';
import { listMonitorsWithComputed } from '../db/repos/monitors.js';
import { createProject, listProjects, updateProject } from '../db/repos/projects.js';
import { listReleasesForProject } from '../db/repos/releases.js';
import { topIssues } from '../db/repos/top-issues.js';
import { usageSummary } from '../db/repos/usage-summary.js';
import type { Db } from '../db/index.js';
import type { ProjectRow } from '../db/schema.js';
import { metrics, registry } from '../metrics/registry.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { validateWebhookUrl } from '../webhooks/url-guard.js';
import { parseMetricsSubset } from '@uh-oh/mcp';
import {
  MAX_ANNOTATION_BODY,
  createAnnotation,
  writeSystemAnnotation,
  toAnnotationView,
} from '../db/repos/annotations.js';
import {
  applyFixAttemptTransition,
  getFixAttempt,
  isAllowedClientTransition,
  toFixAttemptView,
  upsertFixAttempt,
} from '../db/repos/fix-attempts.js';
import { similarIssues } from '../db/repos/similar.js';

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
    // IssueRow now structurally satisfies the (widened) MCP Issue type, so no
    // adapter is needed — the row's real status ('regressed' included) is
    // surfaced directly.
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
    const updated = setIssueStatus(this.db, input.issueId, input.status);
    return Promise.resolve(updated);
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

  getIssueBundle(input: { issueId: string }): Promise<IssueBundle | null> {
    // Same builder the GET /api/issues/:id/bundle route uses, so the in-process
    // and HTTP backends return byte-identical (already size-bounded) bundles.
    return buildIssueBundle(this.db, input.issueId);
  }

  listTopIssues(input: ListTopIssuesInput): Promise<TopIssue[]> {
    return Promise.resolve(topIssues(this.db, { limit: input.limit, days: input.days }));
  }

  listMonitors(input: ListMonitorsInput): Promise<Monitor[]> {
    return Promise.resolve(
      listMonitorsWithComputed(this.db, {
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      }),
    );
  }

  getUsageSummary(input: { projectId: string; days: number }): Promise<UsageSummary> {
    // Same aggregation the GET /api/projects/:id/usage/summary route runs, so
    // the in-process and HTTP backends return identical summaries.
    return Promise.resolve(usageSummary(this.db, input.projectId, input.days));
  }

  // ── v0.8 agent-loop (§23) ───────────────────────────────────────────────────

  listSimilarIssues(input: { issueId: string }): Promise<SimilarIssue[] | null> {
    // Mirrors GET /api/issues/:id/similar, which 404s on an unknown issue.
    if (!getIssue(this.db, input.issueId)) return Promise.resolve(null);
    return Promise.resolve(similarIssues(this.db, input.issueId));
  }

  createAnnotation(input: {
    issueId: string;
    body: string;
    kind?: ClientAnnotationKind;
    author?: string;
  }): Promise<Annotation> {
    // Mirrors POST /api/issues/:id/annotations, which 404s on an unknown issue.
    if (!getIssue(this.db, input.issueId)) {
      throw new BackendError('issue not found', { code: 'not_found', status: 404 });
    }
    // The route caps the body by BYTES (413), not chars — the tool's zod schema
    // only caps chars, so a multi-byte body could slip past it. Re-check here
    // for parity with the HTTP path.
    if (Buffer.byteLength(input.body, 'utf8') > MAX_ANNOTATION_BODY) {
      throw new BackendError('annotation body too large', {
        code: 'body_too_large',
        status: 413,
      });
    }
    const row = createAnnotation(
      this.db,
      {
        issueId: input.issueId,
        body: input.body,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.author !== undefined ? { author: input.author } : {}),
      },
      Date.now(),
    );
    return Promise.resolve(toAnnotationView(row));
  }

  upsertFixAttempt(input: {
    issueId: string;
    prUrl: string;
    commitSha?: string;
  }): Promise<FixAttempt> {
    // Mirrors POST /api/issues/:id/fix-attempts, which 404s on an unknown issue.
    if (!getIssue(this.db, input.issueId)) {
      throw new BackendError('issue not found', { code: 'not_found', status: 404 });
    }
    const { attempt } = upsertFixAttempt(
      this.db,
      {
        issueId: input.issueId,
        prUrl: input.prUrl,
        ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
      },
      Date.now(),
    );
    return Promise.resolve(toFixAttemptView(attempt));
  }

  transitionFixAttempt(input: {
    fixAttemptId: string;
    state: ClientFixAttemptTransition;
  }): Promise<FixAttempt> {
    // Mirrors PATCH /api/fix-attempts/:id: 404 on an unknown attempt, 400 on a
    // transition the state machine does not allow, a system annotation audit
    // trail on every transition, and marking 'deployed' resolves an open or
    // regressed issue (re-arming §18 regression detection).
    const attempt = getFixAttempt(this.db, input.fixAttemptId);
    if (!attempt) {
      throw new BackendError('fix attempt not found', { code: 'not_found', status: 404 });
    }
    if (!isAllowedClientTransition(attempt.state, input.state)) {
      throw new BackendError(`invalid transition ${attempt.state} -> ${input.state}`, {
        code: 'invalid_transition',
        status: 400,
      });
    }

    const now = Date.now();
    this.db.transaction((tx) => {
      applyFixAttemptTransition(tx, attempt, input.state, now);
      writeSystemAnnotation(
        tx,
        attempt.issueId,
        `fix attempt ${input.state}: ${attempt.prUrl} (${attempt.state} -> ${input.state})`,
        now,
      );
      if (input.state === 'deployed') {
        const issue = getIssue(tx, attempt.issueId);
        if (issue && (issue.status === 'open' || issue.status === 'regressed')) {
          setIssueStatus(tx, attempt.issueId, 'resolved');
        }
      }
    });
    if (input.state === 'failed') metrics.fixFailed.inc();

    const updated = getFixAttempt(this.db, attempt.id);
    return Promise.resolve(toFixAttemptView(updated ?? attempt));
  }
}
