import type { FastifyReply, FastifyRequest } from 'fastify';

export const securityHeadersHook = (
  _req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (err?: Error | null, data?: unknown) => void,
): void => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-DNS-Prefetch-Control', 'off');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  done(null, payload);
};
