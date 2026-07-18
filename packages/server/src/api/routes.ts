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
import type { Db } from '../db/index.js';
import { buildAuthMiddleware } from '../auth/middleware.js';
import { buildUploadAuthMiddleware } from '../auth/symbol-token.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';
import { buildIssueBundle } from './bundle.js';
import { validateWebhookUrl } from '../webhooks/url-guard.js';
import { clampDays, issueStats, projectStats } from '../db/repos/stats.js';
import { clampUsageDays, usageSummary } from '../db/repos/usage-summary.js';

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
// 'regressed' status.
type FilterStatusInput = PatchStatusInput | 'regressed';
const isFilterStatus = (s: unknown): s is FilterStatusInput =>
  isPatchStatus(s) || s === 'regressed';

const VALID_SORTS = new Set<IssueSort>(['lastSeen', 'eventCount', 'firstSeen']);
const isSort = (s: unknown): s is IssueSort =>
  typeof s === 'string' && VALID_SORTS.has(s as IssueSort);

export const registerApiRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  symbolToken?: string,
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

  app.get('/api/projects', { preHandler: uploadPreHandler }, () => ({
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
      const { webhookUrl, alertDedupeMinutes, name } = body as {
        webhookUrl?: unknown;
        alertDedupeMinutes?: unknown;
        name?: unknown;
      };
      const patch: { webhookUrl?: string | null; alertDedupeMinutes?: number; name?: string } = {};
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
  }>('/api/projects/:id/issues', { preHandler }, (req, reply) => {
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
    { preHandler },
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
    { preHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return usageSummary(db, project.id, clampUsageDays(req.query.days));
    },
  );

  app.get<{ Params: { id: string } }>('/api/issues/:id', { preHandler }, (req, reply) => {
    const issue = getIssue(db, req.params.id);
    if (!issue) return reply.code(404).send({ error: 'not_found' });
    const latest = getLatestEventForIssue(db, issue.id);
    const breadcrumbs = latest ? listBreadcrumbs(db, latest.id) : [];
    return { issue, latestEvent: latest, breadcrumbs };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/issues/:id',
    { preHandler },
    (req, reply) => {
      const status = (req.body as { status?: unknown } | null)?.status;
      // Only open|resolved|ignored are user-settable; PATCHing a regressed issue
      // to resolved re-arms detection (a later event re-triggers regressed).
      if (!isPatchStatus(status)) return reply.code(400).send({ error: 'invalid_status' });
      const updated = setIssueStatus(db, req.params.id, status);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { issue: updated };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; page?: string };
  }>('/api/issues/:id/events', { preHandler }, (req, reply) => {
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
    { preHandler },
    (req, reply) => {
      const issue = getIssue(db, req.params.id);
      if (!issue) return reply.code(404).send({ error: 'not_found' });
      return issueStats(db, issue.id, clampDays(req.query.days));
    },
  );

  // CONTRACT I — issue impact roll-up.
  app.get<{ Params: { id: string } }>('/api/issues/:id/impact', { preHandler }, (req, reply) => {
    const issue = getIssue(db, req.params.id);
    if (!issue) return reply.code(404).send({ error: 'not_found' });
    return computeImpact(db, issue.id);
  });

  // CONTRACT B — the full fix-dossier bundle (size-bounded server-side).
  app.get<{ Params: { id: string } }>(
    '/api/issues/:id/bundle',
    { preHandler },
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
    { preHandler },
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
