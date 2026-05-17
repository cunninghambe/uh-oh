import { EventEnvelopeSchema } from '@uh-oh/types';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { z } from 'zod';

import { registerApiRoutes } from './api/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import type { Db } from './db/index.js';
import { registerSymbolizationRoutes } from './symbolication/routes.js';
import type { IngestEntry } from './ingest/ingest.js';
import { makeIngest } from './ingest/ingest.js';
import { createRateLimiter } from './ingest/rate-limit.js';
import { createIpRateLimiter, extractIp } from './hardening/ip-rate-limit.js';
import { securityHeadersHook } from './hardening/security-headers.js';
import { registerMetricsRoute } from './metrics/route.js';
import { metrics } from './metrics/registry.js';

export type ServerDeps = {
  db: Db;
  ingest?: IngestEntry;
  logger?: boolean;
  /** JWT secret bytes. Required in production; defaults to a test-only value if omitted. */
  secret?: Uint8Array;
  /** Admin password. Required in production; defaults to '' if omitted. */
  password?: string;
  ipRatePerMinute?: number;
  ipRateBurst?: number;
};

const MAX_BODY_BYTES = 1_048_576;
const SKIP_IP_RATE_LIMIT = new Set(['/healthz', '/metrics']);

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

  const ipLimiter = createIpRateLimiter({
    perMinute: deps.ipRatePerMinute ?? 600,
    burst: deps.ipRateBurst ?? 100,
  });

  // Cleanup stale buckets every 5 minutes
  const cleanupTimer = setInterval(
    () => {
      ipLimiter.cleanup(Date.now());
    },
    5 * 60 * 1000,
  );
  // Don't hold the process open
  cleanupTimer.unref();

  app.addHook('onRequest', async (req, reply) => {
    if (SKIP_IP_RATE_LIMIT.has(req.url)) return;
    const ip = extractIp(req.headers['x-forwarded-for'], req.ip);
    if (!ipLimiter.consume(ip, Date.now())) {
      return reply.code(429).header('Retry-After', '60').send({ error: 'rate_limit_exceeded' });
    }
  });

  app.addHook('onSend', securityHeadersHook);

  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions?.url ?? req.url;
    metrics.requestDuration.observe(
      { route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
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
  registerSymbolizationRoutes(app, deps.db, secret);
  registerMetricsRoute(app);

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
