import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

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

const DEFAULT_MAX_SYMBOL_BYTES = 50 * 1024 * 1024; // 50 MB

export const registerSymbolizationRoutes = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  maxSymbolBytes: number = DEFAULT_MAX_SYMBOL_BYTES,
): void => {
  app.register(multipart, { limits: { fileSize: maxSymbolBytes } });

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

      // Stream to a temp file rather than buffering the whole upload in RAM.
      try {
        await pipeline(data.file, createWriteStream(tmp));
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        if (
          data.file.truncated ||
          (err as { code?: string } | null)?.code === 'FST_REQ_FILE_TOO_LARGE'
        ) {
          return reply.code(413).send({ error: 'file_too_large' });
        }
        req.log.error({ err }, 'symbol write failed');
        return reply.code(500).send({ error: 'write_failed' });
      }
      // A truncated stream can complete without throwing when the limit is hit
      // exactly at EOF — treat that as too-large too.
      if (data.file.truncated) {
        await fs.unlink(tmp).catch(() => undefined);
        return reply.code(413).send({ error: 'file_too_large' });
      }
      await fs.rename(tmp, dest);

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
