import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { deleteSession, insertSession } from '../db/repos/sessions.js';
import { buildAuthMiddleware } from './middleware.js';
import { issueToken } from './jwt.js';
import type { AuthRequest } from './middleware.js';
import type { LoginLimiter } from './login-limiter.js';
import { createLoginLimiter } from './login-limiter.js';

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  password: string,
  loginLimiter: LoginLimiter = createLoginLimiter(),
): void => {
  const auth = buildAuthMiddleware({ db, secret });

  app.post<{ Body: unknown }>(
    '/api/auth/login',
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Trust `request.ip` — with `trustProxy: 'loopback'` this is the real
      // client IP when nginx forwards it, and the socket peer otherwise (a
      // direct/spoofed caller cannot forge it).
      const limit = loginLimiter.check(req.ip);
      if (!limit.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(limit.retryAfterSec))
          .send({ error: 'rate_limited' });
      }

      const body = req.body;
      if (typeof body !== 'object' || body === null) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      const submitted = (body as { password?: unknown }).password;
      if (typeof submitted !== 'string') {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
      const match = timingSafeEqual(sha(submitted), sha(password));

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
