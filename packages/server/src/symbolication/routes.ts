import fs from 'node:fs/promises';

import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { buildAuthMiddleware } from '../auth/middleware.js';
import {
  getReleaseById,
  listReleasesForProject,
  markMappingUploaded,
  markSourcemapUploaded,
} from '../db/repos/releases.js';
import { getProjectById } from '../db/repos/projects.js';
import { ensureSymbolsDir, mappingPath, sourcemapPath } from './storage.js';
import { invalidateSymbolications } from './symbolicate.js';

const MAX_SYMBOL_BYTES = 50 * 1024 * 1024; // 50 MB

export const registerSymbolizationRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
): void => {
  app.register(multipart, { limits: { fileSize: MAX_SYMBOL_BYTES } });

  const auth = buildAuthMiddleware({ db, secret });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/releases',
    { preHandler },
    (req, reply) => {
      const project = getProjectById(db, req.params.id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return { releases: listReleasesForProject(db, project.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/releases/:id/symbols',
    { preHandler },
    async (req, reply) => {
      const release = getReleaseById(db, req.params.id);
      if (!release) return reply.code(404).send({ error: 'release_not_found' });

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: 'missing_file' });

      const platformField = data.fields['platform'];
      const platform =
        platformField && !Array.isArray(platformField) && platformField.type === 'field'
          ? platformField.value
          : undefined;

      if (!platform) return reply.code(400).send({ error: 'missing_platform' });

      const sourcemapField = data.fields['sourcemap'];
      const sourcemapStr =
        sourcemapField && !Array.isArray(sourcemapField) && sourcemapField.type === 'field'
          ? sourcemapField.value
          : 'false';
      const isSourcemap = sourcemapStr === 'true';

      await ensureSymbolsDir(release.id);
      const dest = isSourcemap ? sourcemapPath(release.id) : mappingPath(release.id);
      const tmp = dest + '.tmp';

      try {
        const buf = await data.toBuffer();
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, dest);
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        req.log.error({ err }, 'symbol write failed');
        return reply.code(500).send({ error: 'write_failed' });
      }

      const now = Date.now();
      if (isSourcemap) {
        markSourcemapUploaded(db, release.id, now);
      } else {
        markMappingUploaded(db, release.id, now);
      }
      invalidateSymbolications(db, release.id);

      const updated = getReleaseById(db, release.id);
      return { release: updated };
    },
  );
};

// Re-export path utility so server.ts can import from a single module
export { mappingPath, sourcemapPath } from './storage.js';
