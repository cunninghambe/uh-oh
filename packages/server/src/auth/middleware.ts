import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { sessionExists } from '../db/repos/sessions.js';
import { verifyToken } from './jwt.js';

export type AuthRequest = FastifyRequest & { auth?: { jti: string } };

export const buildAuthMiddleware =
  (deps: { db: Db; secret: Uint8Array; now?: () => number }) =>
  async (req: AuthRequest, reply: FastifyReply): Promise<void> => {
    const now = deps.now ?? (() => Date.now());
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const token = authHeader.slice(7);
    let payload: Awaited<ReturnType<typeof verifyToken>>;
    try {
      payload = await verifyToken(token, deps.secret);
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (!sessionExists(deps.db, payload.jti, now())) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    req.auth = { jti: payload.jti };
  };
