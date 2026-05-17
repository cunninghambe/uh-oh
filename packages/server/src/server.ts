import { EventEnvelopeSchema } from '@uh-oh/types';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { z } from 'zod';

import { registerApiRoutes } from './api/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { Db } from './db/index.js';
import type { IngestEntry } from './ingest/ingest.js';
import { makeIngest } from './ingest/ingest.js';
import { createRateLimiter } from './ingest/rate-limit.js';

export type ServerDeps = {
  db: Db;
  ingest?: IngestEntry;
  logger?: boolean;
  /** JWT secret bytes. Required in production; defaults to a test-only value if omitted. */
  secret?: Uint8Array;
  /** Admin password. Required in production; defaults to '' if omitted. */
  password?: string;
};

const MAX_BODY_BYTES = 1_048_576;

export const buildServer = (deps: ServerDeps): FastifyInstance => {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
  });

  const ingest =
    deps.ingest ??
    makeIngest({
      db: deps.db,
      rateLimiter: createRateLimiter({ capacity: 10, refillPerSec: 1 }),
    });

  app.post<{ Params: { publicKey: string }; Body: unknown }>('/ingest/:publicKey', (req, reply) => {
    const parsed = EventEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_envelope',
        issues: parsed.error.issues.map((i: z.core.$ZodIssue) => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      });
    }

    const result = ingest(req.params.publicKey, parsed.data);

    if (result.kind === 'unknown-key') {
      return reply.code(401).send({ error: 'unknown_public_key' });
    }
    if (result.kind === 'rate-limited') {
      return reply.code(202).send({ eventId: null, rateLimited: true });
    }
    return reply.code(202).send({ eventId: result.eventId });
  });

  app.get('/healthz', () => ({ ok: true }));

  const secret =
    deps.secret ?? new TextEncoder().encode('test-secret-for-vitest-do-not-use-in-prod!!!');
  const password = deps.password ?? '';

  registerAuthRoutes(app, deps.db, secret, password);
  registerApiRoutes(app, deps.db, secret);

  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({ error: 'payload_too_large' });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  return app;
};
