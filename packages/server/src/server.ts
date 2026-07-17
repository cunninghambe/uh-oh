import { EventEnvelopeSchema } from '@uh-oh/types';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { z } from 'zod';

import { registerApiRoutes } from './api/routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createLoginLimiter } from './auth/login-limiter.js';
import type { Db } from './db/index.js';
import { registerSymbolizationRoutes } from './symbolication/routes.js';
import type { IngestEntry } from './ingest/ingest.js';
import { makeIngest } from './ingest/ingest.js';
import { createRateLimiter } from './ingest/rate-limit.js';
import { createIpRateLimiter } from './hardening/ip-rate-limit.js';
import { securityHeadersHook } from './hardening/security-headers.js';
import { registerMetricsRoute } from './metrics/route.js';
import { metrics } from './metrics/registry.js';

export type ServerDeps = {
  db: Db;
  ingest?: IngestEntry;
  logger?: boolean;
  /** JWT secret bytes. REQUIRED — buildServer throws if empty. */
  secret: Uint8Array;
  /** Admin password. REQUIRED — buildServer throws if empty. */
  password: string;
  ipRatePerMinute?: number;
  ipRateBurst?: number;
  /** Max symbol upload size in bytes (default 50 MB). */
  maxSymbolBytes?: number;
};

const MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_SYMBOL_BYTES = 50 * 1024 * 1024;
const SKIP_IP_RATE_LIMIT = new Set(['/healthz', '/metrics']);

export const buildServer = (deps: ServerDeps): FastifyInstance => {
  if (!deps.secret || deps.secret.length === 0) {
    throw new Error('buildServer requires a non-empty JWT secret');
  }
  if (!deps.password || deps.password.length === 0) {
    throw new Error('buildServer requires a non-empty admin password');
  }

  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: MAX_BODY_BYTES,
    // nginx overwrites X-Forwarded-For with the real client IP (single hop) and
    // is the only trusted proxy. `request.ip` then reflects the true client when
    // the peer is loopback, and the socket address otherwise — so a direct caller
    // cannot spoof their IP via X-Forwarded-For.
    trustProxy: 'loopback',
  });

  const ingestRateLimiter = createRateLimiter({ capacity: 10, refillPerSec: 1 });
  const ingest = deps.ingest ?? makeIngest({ db: deps.db, rateLimiter: ingestRateLimiter });

  const ipLimiter = createIpRateLimiter({
    perMinute: deps.ipRatePerMinute ?? 600,
    burst: deps.ipRateBurst ?? 100,
  });
  const loginLimiter = createLoginLimiter();

  // Sweep stale buckets across all in-memory limiters every 5 minutes.
  const cleanupTimer = setInterval(
    () => {
      const now = Date.now();
      ipLimiter.cleanup(now);
      ingestRateLimiter.cleanup(now);
      loginLimiter.cleanup(now);
    },
    5 * 60 * 1000,
  );
  // Don't hold the process open
  cleanupTimer.unref();
  app.addHook('onClose', (_instance, done) => {
    clearInterval(cleanupTimer);
    done();
  });

  app.addHook('onRequest', async (req, reply) => {
    if (SKIP_IP_RATE_LIMIT.has(req.url)) return;
    if (!ipLimiter.consume(req.ip, Date.now())) {
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

  // Ingest is called cross-origin from RN apps → open CORS on this route only.
  // `/api/*` stays same-origin (no CORS headers emitted).
  app.options<{ Params: { publicKey: string } }>('/ingest/:publicKey', (_req, reply) => {
    return reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'content-type')
      .header('Access-Control-Max-Age', '86400')
      .code(204)
      .send();
  });

  app.post<{ Params: { publicKey: string }; Body: unknown }>('/ingest/:publicKey', (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
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

  registerAuthRoutes(app, deps.db, deps.secret, deps.password, loginLimiter);
  registerApiRoutes(app, deps.db, deps.secret);
  registerSymbolizationRoutes(
    app,
    deps.db,
    deps.secret,
    deps.maxSymbolBytes ?? DEFAULT_MAX_SYMBOL_BYTES,
  );
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
