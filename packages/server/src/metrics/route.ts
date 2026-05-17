import type { FastifyInstance } from 'fastify';

import { registry } from './registry.js';

export const registerMetricsRoute = (app: FastifyInstance): void => {
  app.get('/metrics', async (_req, reply) => {
    const text = await registry.metrics();
    return reply.code(200).header('Content-Type', 'text/plain; version=0.0.4').send(text);
  });
};
