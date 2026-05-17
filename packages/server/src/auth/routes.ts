import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { deleteSession, insertSession } from '../db/repos/sessions.js';
import { createRateLimiter } from '../ingest/rate-limit.js';
import { buildAuthMiddleware } from './middleware.js';
import { issueToken } from './jwt.js';
import type { AuthRequest } from './middleware.js';

const loginLimiter = createRateLimiter({ capacity: 10, refillPerSec: 10 / 60 });

const getClientIp = (req: FastifyRequest): string =>
  (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
  req.socket.remoteAddress ??
  'unknown';

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  password: string,
): void => {
  const auth = buildAuthMiddleware({ db, secret });

  app.post<{ Body: unknown }>(
    '/api/auth/login',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = getClientIp(req);
      if (!loginLimiter.consume(ip)) {
        return reply.code(429).header('Retry-After', '60').send({ error: 'rate_limited' });
      }

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const submitted = (body as { password?: unknown }).password;
      if (typeof submitted !== 'string') {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const a = Buffer.from(submitted.padEnd(password.length));
      const b = Buffer.from(password);
      const match = submitted.length === password.length && timingSafeEqual(a, b);

      if (!match) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const { token, jti, expiresAt } = await issueToken(secret);
      insertSession(db, jti, expiresAt);
      return reply.send({ token });
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void> },
    async (req: AuthRequest, reply: FastifyReply) => {
      const jti = req.auth?.jti;
      if (jti) deleteSession(db, jti);
      return reply.code(204).send();
    },
  );
};
