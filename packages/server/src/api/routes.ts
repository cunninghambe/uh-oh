import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getEvent, getLatestEventForIssue, listEventsForIssue } from '../db/repos/events.js';
import { listBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { getIssue, listIssues, setIssueStatus } from '../db/repos/issues.js';
import {
  createProject,
  getProjectById,
  listProjects,
  rotateProjectPublicKey,
  updateProject,
} from '../db/repos/projects.js';
import type { Db } from '../db/index.js';
import { buildAuthMiddleware } from '../auth/middleware.js';
import { symbolicateEvent } from '../symbolication/symbolicate.js';

type IssueStatusInput = 'open' | 'resolved' | 'ignored';
const isStatus = (s: unknown): s is IssueStatusInput =>
  s === 'open' || s === 'resolved' || s === 'ignored';

export const registerApiRoutes = (app: FastifyInstance, db: Db, secret: Uint8Array): void => {
  const auth = buildAuthMiddleware({ db, secret });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  app.get('/api/projects', { preHandler }, () => ({ projects: listProjects(db) }));

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
        if (webhookUrl !== null && (typeof webhookUrl !== 'string' || webhookUrl.length > 1024)) {
          return reply.code(400).send({ error: 'invalid_webhookUrl' });
        }
        patch.webhookUrl = webhookUrl;
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
    Querystring: { status?: string; limit?: string; offset?: string };
  }>('/api/projects/:id/issues', { preHandler }, (req, reply) => {
    const project = getProjectById(db, req.params.id);
    if (!project) return reply.code(404).send({ error: 'project_not_found' });
    const status = isStatus(req.query.status) ? req.query.status : undefined;
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    const result = listIssues(db, {
      projectId: project.id,
      ...(status ? { status } : {}),
      limit,
      offset,
    });
    return { issues: result.rows, total: result.total };
  });

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
      if (!isStatus(status)) return reply.code(400).send({ error: 'invalid_status' });
      const updated = setIssueStatus(db, req.params.id, status);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { issue: updated };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/api/issues/:id/events', { preHandler }, (req, reply) => {
    const issue = getIssue(db, req.params.id);
    if (!issue) return reply.code(404).send({ error: 'not_found' });
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    const offset = req.query.offset ? Math.max(0, Number(req.query.offset)) : 0;
    const events = listEventsForIssue(db, issue.id, { limit, offset });
    return { events };
  });

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
