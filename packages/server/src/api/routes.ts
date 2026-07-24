import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getEvent, getLatestEventForIssue, listEventsForIssue } from '../db/repos/events.js';
import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getIssue, listIssues, setIssueStatus, type IssueSort } from '../db/repos/issues.js';
import {
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  rotateProjectPublicKey,
  updateProject,
} from '../db/repos/projects.js';
import { computeImpact } from '../db/repos/impact.js';
import { topIssues } from '../db/repos/top-issues.js';
import { listFixAttempts, toFixAttemptView } from '../db/repos/fix-attempts.js';
import { getAliasTarget } from '../db/repos/fingerprint-aliases.js';
import { mergeIssueInto } from '../db/repos/merge.js';
import { clampReleaseHealthDays, releaseHealth } from '../db/repos/release-health.js';
import type { Db } from '../db/index.js';
import { buildAuthMiddleware } from '../auth/middleware.js';
import { buildUploadAuthMiddleware } from '../auth/symbol-token.js';
import { buildReadAuthMiddleware } from '../auth/read-token.js';
import { buildAgentAuthMiddleware } from '../auth/agent-token.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { buildIssueBundle } from './bundle.js';
import { validateWebhookUrl } from '../webhooks/url-guard.js';
import { clampDays, issueStats, projectStats } from '../db/repos/stats.js';
import { clampUsageDays, usageSummary } from '../db/repos/usage-summary.js';
import { metrics } from '../metrics/registry.js';

// list_top_issues bounds (mirrored by the MCP tool schema).
const MAX_TOP_ISSUES = 25;
const MAX_TOP_DAYS = 30;
const clampInt = (raw: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
};

// User-settable statuses (PATCH). 'regressed' is system-set by ingest and is
// intentionally NOT accepted from users.
type PatchStatusInput = 'open' | 'resolved' | 'ignored';
const isPatchStatus = (s: unknown): s is PatchStatusInput =>
  s === 'open' || s === 'resolved' || s === 'ignored';

// The issues list `status` filter additionally accepts the system-set
// 'regressed' status, and (v0.9 §24) the terminal 'merged' status — the ONLY way
// to surface merged issues, which the default listing hides.
type FilterStatusInput = PatchStatusInput | 'regressed' | 'merged';
const isFilterStatus = (s: unknown): s is FilterStatusInput =>
  isPatchStatus(s) || s === 'regressed' || s === 'merged';

const VALID_SORTS = new Set<IssueSort>(['lastSeen', 'eventCount', 'firstSeen']);
const isSort = (s: unknown): s is IssueSort =>
  typeof s === 'string' && VALID_SORTS.has(s as IssueSort);

export const registerApiRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  symbolToken?: string,
  readToken?: string,
  agentToken?: string,
): void => {
  const auth = buildAuthMiddleware({ db, secret });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // CONTRACT T: GET /api/projects is part of the symbol-upload flow (slug
  // resolution), so it additionally accepts the scoped upload token. EVERY other
  // route below keeps the JWT-only `preHandler`, which rejects the token.
  const uploadPreHandler = buildUploadAuthMiddleware({ db, secret, symbolToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  // CONTRACT R (§22) + A (§23): the read token authorizes exactly the allowlisted
  // GET routes below; the agent token authorizes them too (it authorizes
  // everything the read token does). `readPreHandler` accepts either scoped token
  // OR a JWT; the non-allowlisted routes keep the JWT-only `preHandler` (or upload
  // handler), so they reject both scoped tokens exactly as they reject no auth.
  const readPreHandler = buildReadAuthMiddleware({ db, secret, readToken, agentToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  // CONTRACT A (§23): the agent token additionally authorizes exactly four writes
  // (this one: PATCH /api/issues/:id). It accepts the agent token OR a JWT; a read
  // token does NOT match and falls through to the JWT check (rejected).
  const agentPreHandler = buildAgentAuthMiddleware({ db, secret, agentToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  // GET /api/projects belongs to BOTH allowlists: read/agent token, symbol token,
  // OR a JWT. Read is tried first, then it falls back to the upload handler.
  const readOrUploadPreHandler = buildReadAuthMiddleware({
    db,
    secret,
    readToken,
    agentToken,
    fallback: uploadPreHandler,
  }) as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  app.get('/api/projects', { preHandler: readOrUploadPreHandler }, () => ({
    projects: listProjects(db),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id', { preHandler }, (req, reply) => {
    const project = getProjectById(db, req.params.id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    return { project };
  });

  app.post<{ Body: unknown }>('/api/projects', { preHandler }, (req, reply) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const name = (body as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    return reply.code(201).send({ project: createProject(db, { name }) });
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id',
    { preHandler },
    (req, reply) => {
      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { webhookUrl, alertDedupeMinutes, name, repoUrl } = body as {
        webhookUrl?: unknown;
        alertDedupeMinutes?: unknown;
        name?: unknown;
        repoUrl?: unknown;
      };
      const patch: {
        webhookUrl?: string | null;
        alertDedupeMinutes?: number;
        name?: string;
        repoUrl?: string | null;
      } = {};
      if (webhookUrl !== undefined) {
        if (webhookUrl === null) {
          patch.webhookUrl = null;
        } else if (typeof webhookUrl !== 'string' || webhookUrl.length > 1024) {
          return reply.code(400).send({ error: 'invalid_webhookUrl' });
        } else if (!validateWebhookUrl(webhookUrl).ok) {
          // Reject SSRF-prone targets (loopback/private/link-local/metadata IPs,
          // non-http(s) schemes) before they are ever stored or dispatched.
          return reply.code(400).send({ error: 'invalid_webhookUrl' });
        } else {
          patch.webhookUrl = webhookUrl;
        }
      }
      if (alertDedupeMinutes !== undefined) {
        if (
          typeof alertDedupeMinutes !== 'number' ||
          !Number.isInteger(alertDedupeMinutes) ||
          alertDedupeMinutes < 0
        ) {
          return reply.code(400).send({ error: 'invalid_alertDedupeMinutes' });
        }
        patch.alertDedupeMinutes = alertDedupeMinutes;
      }
      if (name !== undefined) {
        if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
          return reply.code(400).send({ error: 'invalid_name' });
        }
        patch.name = name;
      }
      // repoUrl (§23): ≤512 chars, nullable to clear. The server never contacts
      // the git host, so no SSRF check — it is only stored + echoed.
      if (repoUrl !== undefined) {
        if (repoUrl === null) {
          patch.repoUrl = null;
        } else if (typeof repoUrl !== 'string' || repoUrl.length > 512) {
          return reply.code(400).send({ error: 'invalid_repoUrl' });
        } else {
          patch.repoUrl = repoUrl;
        }
      }
      const updated = updateProject(db, req.params.id, patch);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { project: updated };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { preHandler }, (req, reply) => {
    const deleted = deleteProject(db, req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/rotate-key',
    { preHandler },
    (req, reply) => {
      const updated = rotateProjectPublicKey(db, req.params.id);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { project: updated };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { status?: string; sort?: string; limit?: string; offset?: string };
  }>('/api/projects/:id/issues', { preHandler: readPreHandler }, (req, reply) => {
    const project = getProjectById(db, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project_not_found' });
    const status = isFilterStatus(req.query.status) ? req.query.status : undefined;
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    if (req.query.sort !== undefined && !isSort(req.query.sort)) {
      return reply.code(400).send({ error: 'invalid_sort' });
    }
    const sort = isSort(req.query.sort) ? req.query.sort : undefined;
    const result = listIssues(db, {
      projectId: project.id,
      ...(status ? { status } : {}),
      ...(sort ? { sort } : {}),
      limit,
      offset,
    });
    return { issues: result.rows, total: result.total };
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/projects/:id/stats',
    { preHandler: readPreHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return projectStats(db, project.id, clampDays(req.query.days));
    },
  );

  // CONTRACT U-API — privacy-first usage analytics summary (days clamped 1..90,
  // default 30).
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/projects/:id/usage/summary',
    { preHandler: readPreHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return usageSummary(db, project.id, clampUsageDays(req.query.days));
    },
  );

  // §24 — per-release crash health vs. attributed usage pageviews (days clamped
  // 1..90, default 30). Same read allowlist as the other project reads.
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/projects/:id/release-health',
    { preHandler: readPreHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return releaseHealth(db, project.id, clampReleaseHealthDays(req.query.days));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/issues/:id',
    { preHandler: readPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      const latest = getLatestEventForIssue(db, issue.id);
      const breadcrumbs = latest ? listBreadcrumbs(db, latest.id) : [];
      // §23: expose fix attempts (newest first) on the detail. spikeActive /
      // lastSpikeAt ride along on the `issue` row itself.
      const fixAttempts = listFixAttempts(db, issue.id).map(toFixAttemptView);
      // §24: a merged issue points the dashboard at its target. The pointer is the
      // target of the alias for the issue's own fingerprint (null otherwise).
      const mergedInto =
        issue.status === 'merged' ? getAliasTarget(db, issue.projectId, issue.fingerprint) : null;
      return { issue, latestEvent: latest, breadcrumbs, fixAttempts, mergedInto };
    },
  );

  // CONTRACT A (§23): reclassified from JWT-only to agent scope — the agent token
  // (or a JWT) may change an issue's status; the read token still cannot.
  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/issues/:id',
    { preHandler: agentPreHandler },
    (req, reply) => {
      const status = (req.body as { status?: unknown } | null)?.status;
      // Only open|resolved|ignored are user-settable; PATCHing a regressed issue
      // to resolved re-arms detection (a later event re-triggers regressed).
      if (!isPatchStatus(status)) return reply.code(400).send({ error: 'invalid_status' });
      const existing = getIssue(db, req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });
      // §24: 'merged' is a terminal status — a merged issue cannot be re-opened.
      if (existing.status === 'merged') return reply.code(409).send({ error: 'issue_merged' });
      const updated = setIssueStatus(db, req.params.id, status);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { issue: updated };
    },
  );

  // §24: merge this issue into another (JWT only — deliberately not agent-scoped).
  // In one transaction the source's events/annotations/fix-attempts move to the
  // target, the target's counts recompute, the source's fingerprint (and its
  // existing aliases) become aliases of the target, and the source flips to the
  // terminal 'merged' status. Ingest then routes the source's fingerprint here.
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/issues/:id/merge',
    { preHandler },
    (req, reply) => {
      const source = getIssue(db, req.params.id);
      if (!source) return reply.code(404).send({ error: 'not_found' });
      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const into = (body as { into?: unknown }).into;
      if (typeof into !== 'string' || into.length === 0) {
        return reply.code(400).send({ error: 'invalid_into' });
      }
      const target = getIssue(db, into);
      if (!target) return reply.code(404).send({ error: 'target_not_found' });
      if (target.id === source.id) {
        return reply.code(400).send({ error: 'cannot_merge_into_self' });
      }
      if (target.projectId !== source.projectId) {
        return reply.code(400).send({ error: 'cross_project_merge' });
      }
      // A merged issue is terminal: it can be neither a source nor a target again.
      if (source.status === 'merged') {
        return reply.code(400).send({ error: 'source_already_merged' });
      }
      if (target.status === 'merged') {
        return reply.code(400).send({ error: 'target_merged' });
      }
      db.transaction((tx) => {
        mergeIssueInto(tx, source, target, Date.now());
      });
      metrics.issuesMerged.inc();
      const updatedTarget = getIssue(db, target.id);
      return { merged: true, issue: updatedTarget, mergedInto: target.id };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; page?: string };
  }>('/api/issues/:id/events', { preHandler: readPreHandler }, (req, reply) => {
    const issue = getIssue(db, req.params.id);
    if (!issue) return reply.code(404).send({ error: 'not_found' });
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    // SPEC §9 documents page= (1-indexed); offset= kept for back-compat.
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : undefined;
    const offset =
      page !== undefined
        ? (page - 1) * limit
        : req.query.offset
          ? Math.max(0, Number(req.query.offset))
          : 0;
    const { rows, total } = listEventsForIssue(db, issue.id, { limit, offset });
    return { events: rows, total };
  });

  app.get<{ Params: { id: string }; Querystring: { days?: string } }>(
    '/api/issues/:id/stats',
    { preHandler: readPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      return issueStats(db, issue.id, clampDays(req.query.days));
    },
  );

  // CONTRACT I — issue impact roll-up.
  app.get<{ Params: { id: string } }>(
    '/api/issues/:id/impact',
    { preHandler: readPreHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      return computeImpact(db, issue.id);
    },
  );

  // CONTRACT B — the full fix-dossier bundle (size-bounded server-side).
  app.get<{ Params: { id: string } }>(
    '/api/issues/:id/bundle',
    { preHandler: readPreHandler },
    async (req, reply) => {
      const bundle = await buildIssueBundle(db, req.params.id);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });
      return bundle;
    },
  );

  // Open/regressed issues across ALL projects, ranked by windowed event volume.
  app.get<{ Querystring: { limit?: string; days?: string } }>(
    '/api/top-issues',
    { preHandler },
    (req) => {
      const limit = clampInt(req.query.limit, 1, MAX_TOP_ISSUES, MAX_TOP_ISSUES);
      const days = clampInt(req.query.days, 1, MAX_TOP_DAYS, 14);
      return { issues: topIssues(db, { limit, days }) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { symbolicate?: string } }>(
    '/api/events/:id',
    { preHandler: readPreHandler },
    async (req, reply) => {
      const event = getEvent(db, req.params.id);
      if (!event) return reply.code(404).send({ error: 'not_found' });
      const breadcrumbs = listBreadcrumbs(db, event.id);

      if (req.query.symbolicate === 'true') {
        const frames = await symbolicateEvent(db, event.id);
        return { event, breadcrumbs, frames };
      }

      return { event, breadcrumbs };
    },
  );
};
