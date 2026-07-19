// CONTRACT M — monitor CRUD (JWT). List (with computed `overdue`), patch
// (name / cadence / pause-resume), and delete. Registered separately from the
// core API routes to keep each module focused.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { buildAuthMiddleware } from '../auth/middleware.js';
import { buildReadAuthMiddleware } from '../auth/read-token.js';
import type { Db } from '../db/index.js';
import {
  deleteMonitor,
  getMonitor,
  isOverdue,
  listMonitorsWithComputed,
  updateMonitor,
  type MonitorStatus,
} from '../db/repos/monitors.js';
import { getProjectById } from '../db/repos/projects.js';
import type { MonitorRow } from '../db/schema.js';

// PATCH accepts only the user-settable statuses; 'missed' is system-set by the
// sweep and cleared by a check-in, never by the API.
const isPatchMonitorStatus = (s: unknown): s is 'ok' | 'paused' => s === 'ok' || s === 'paused';

const withOverdue = (m: MonitorRow, now: number): MonitorRow & { overdue: boolean } => ({
  ...m,
  overdue: isOverdue(m, now),
});

export const registerMonitorRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  readToken?: string,
): void => {
  const auth = buildAuthMiddleware({ db, secret });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  // CONTRACT R (§22): the monitor LIST is on the read allowlist (read token OR
  // JWT); monitor CRUD below keeps the JWT-only `preHandler`.
  const readPreHandler = buildReadAuthMiddleware({ db, secret, readToken }) as (
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

  app.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/monitors/:id',
    { preHandler },
    (req, reply) => {
      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const { name, intervalMinutes, graceMinutes, status } = body as {
        name?: unknown;
        intervalMinutes?: unknown;
        graceMinutes?: unknown;
        status?: unknown;
      };
      const patch: Partial<
        Pick<MonitorRow, 'name' | 'intervalMinutes' | 'graceMinutes' | 'status'>
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
