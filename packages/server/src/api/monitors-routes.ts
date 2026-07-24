// CONTRACT M — monitor CRUD (JWT). List (with computed `overdue`), create (v0.9
// http monitors), patch (name / cadence / pause-resume / http url + timeout), and
// delete. Registered separately from the core API routes to keep each module
// focused. Check-in monitors are still auto-created by their first ping; the POST
// route creates http (probe) monitors, whose `kind` is immutable thereafter.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { buildAuthMiddleware } from '../auth/middleware.js';
import { buildReadAuthMiddleware } from '../auth/read-token.js';
import type { Db } from '../db/index.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_PROBE_TIMEOUT_MS,
  MONITOR_SLUG_RE,
  createMonitor,
  defaultGraceMinutes,
  deleteMonitor,
  getMonitor,
  getMonitorBySlug,
  isOverdue,
  listMonitorsWithComputed,
  updateMonitor,
  type MonitorStatus,
} from '../db/repos/monitors.js';
import { getProjectById } from '../db/repos/projects.js';
import { validateWebhookUrl } from '../webhooks/url-guard.js';
import type { MonitorRow } from '../db/schema.js';

// PATCH accepts only the user-settable statuses; 'missed' is system-set by the
// sweep and cleared by a check-in / probe success, never by the API.
const isPatchMonitorStatus = (s: unknown): s is 'ok' | 'paused' => s === 'ok' || s === 'paused';

/** Max URL length for an http monitor (mirrors the webhook URL cap). */
const MAX_MONITOR_URL = 1024;

// `overdue` is a check-in concept (past its ping deadline). http monitors carry
// their health in `status`, so they always report `overdue: false`.
const withOverdue = (m: MonitorRow, now: number): MonitorRow & { overdue: boolean } => ({
  ...m,
  overdue: m.kind === 'checkin' && isOverdue(m, now),
});

export const registerMonitorRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  readToken?: string,
  agentToken?: string,
): void => {
  const auth = buildAuthMiddleware({ db, secret });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // CONTRACT R (§22) + A (§23): the monitor LIST is on the read allowlist (read
  // token, agent token, OR JWT); monitor CRUD below keeps the JWT-only
  // `preHandler`, rejecting both scoped tokens.
  const readPreHandler = buildReadAuthMiddleware({ db, secret, readToken, agentToken }) as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/monitors',
    { preHandler: readPreHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return { monitors: listMonitorsWithComputed(db, { projectId: project.id }) };
    },
  );

  // v0.9 §24: create an http (uptime probe) monitor. Check-in monitors are
  // auto-created by their first ping, so this route is http-only.
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/monitors',
    { preHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { kind, slug, url, intervalMinutes, timeoutMs, name } = body as {
        kind?: unknown;
        slug?: unknown;
        url?: unknown;
        intervalMinutes?: unknown;
        timeoutMs?: unknown;
        name?: unknown;
      };

      if (kind !== 'http') return reply.code(400).send({ error: 'invalid_kind' });
      if (typeof slug !== 'string' || !MONITOR_SLUG_RE.test(slug)) {
        return reply.code(400).send({ error: 'invalid_slug' });
      }
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_MONITOR_URL) {
        return reply.code(400).send({ error: 'invalid_url' });
      }
      // SSRF guard at save time (scheme + literal-IP + localhost), exactly like a
      // webhook URL. The probe re-checks (incl. DNS) at request time.
      if (!validateWebhookUrl(url).ok) {
        return reply.code(400).send({ error: 'invalid_url' });
      }
      if (
        typeof intervalMinutes !== 'number' ||
        !Number.isInteger(intervalMinutes) ||
        intervalMinutes < 1
      ) {
        return reply.code(400).send({ error: 'invalid_intervalMinutes' });
      }
      let timeout = DEFAULT_PROBE_TIMEOUT_MS;
      if (timeoutMs !== undefined) {
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
          return reply.code(400).send({ error: 'invalid_timeoutMs' });
        }
        // Cap (not reject) an over-large timeout.
        timeout = Math.min(timeoutMs, MAX_PROBE_TIMEOUT_MS);
      }
      if (
        name !== undefined &&
        (typeof name !== 'string' || name.length === 0 || name.length > 128)
      ) {
        return reply.code(400).send({ error: 'invalid_name' });
      }

      if (getMonitorBySlug(db, project.id, slug)) {
        return reply.code(409).send({ error: 'slug_exists' });
      }

      const now = Date.now();
      const created = createMonitor(db, {
        projectId: project.id,
        slug,
        ...(typeof name === 'string' ? { name } : {}),
        intervalMinutes,
        graceMinutes: defaultGraceMinutes(intervalMinutes),
        kind: 'http',
        url,
        timeoutMs: timeout,
        now,
      });
      return reply.code(201).send({ monitor: withOverdue(created, now) });
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/monitors/:id',
    { preHandler },
    (req, reply) => {
      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const existing = getMonitor(db, req.params.id);
      if (!existing) return reply.code(404).send({ error: 'not_found' });

      const { name, intervalMinutes, graceMinutes, status, kind, url, timeoutMs } = body as {
        name?: unknown;
        intervalMinutes?: unknown;
        graceMinutes?: unknown;
        status?: unknown;
        kind?: unknown;
        url?: unknown;
        timeoutMs?: unknown;
      };
      // kind is immutable after create.
      if (kind !== undefined && kind !== existing.kind) {
        return reply.code(400).send({ error: 'kind_immutable' });
      }
      const patch: Partial<
        Pick<
          MonitorRow,
          'name' | 'intervalMinutes' | 'graceMinutes' | 'status' | 'url' | 'timeoutMs'
        >
      > = {};

      if (name !== undefined) {
        if (name === null) {
          patch.name = null;
        } else if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
          return reply.code(400).send({ error: 'invalid_name' });
        } else {
          patch.name = name;
        }
      }
      if (intervalMinutes !== undefined) {
        if (
          typeof intervalMinutes !== 'number' ||
          !Number.isInteger(intervalMinutes) ||
          intervalMinutes < 1
        ) {
          return reply.code(400).send({ error: 'invalid_intervalMinutes' });
        }
        patch.intervalMinutes = intervalMinutes;
      }
      if (graceMinutes !== undefined) {
        if (
          typeof graceMinutes !== 'number' ||
          !Number.isInteger(graceMinutes) ||
          graceMinutes < 0
        ) {
          return reply.code(400).send({ error: 'invalid_graceMinutes' });
        }
        patch.graceMinutes = graceMinutes;
      }
      if (status !== undefined) {
        if (!isPatchMonitorStatus(status)) {
          return reply.code(400).send({ error: 'invalid_status' });
        }
        patch.status = status satisfies MonitorStatus;
      }
      // url / timeoutMs edits apply to http monitors only.
      if (url !== undefined) {
        if (existing.kind !== 'http') {
          return reply.code(400).send({ error: 'url_not_applicable' });
        }
        if (typeof url !== 'string' || url.length === 0 || url.length > MAX_MONITOR_URL) {
          return reply.code(400).send({ error: 'invalid_url' });
        }
        if (!validateWebhookUrl(url).ok) {
          return reply.code(400).send({ error: 'invalid_url' });
        }
        patch.url = url;
      }
      if (timeoutMs !== undefined) {
        if (existing.kind !== 'http') {
          return reply.code(400).send({ error: 'timeoutMs_not_applicable' });
        }
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
          return reply.code(400).send({ error: 'invalid_timeoutMs' });
        }
        patch.timeoutMs = Math.min(timeoutMs, MAX_PROBE_TIMEOUT_MS);
      }

      const updated = updateMonitor(db, req.params.id, patch);
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return { monitor: withOverdue(updated, Date.now()) };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/monitors/:id', { preHandler }, (req, reply) => {
    if (!getMonitor(db, req.params.id)) return reply.code(404).send({ error: 'not_found' });
    deleteMonitor(db, req.params.id);
    return reply.code(204).send();
  });
};
