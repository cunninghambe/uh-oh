import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import multipart from '@fastify/multipart';
import type { MultipartFile } from '@fastify/multipart';
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
import { ensureSymbolsDir, mappingPath, platformSymbolsDir, sourcemapPath } from './storage.js';
import { invalidateSymbolications } from './symbolicate.js';
import {
  isUnderDir,
  isWebPlatform,
  listWebSymbolMaps,
  sanitizeBundlePath,
  webSymbolMapPath,
} from './web-symbols.js';

const DEFAULT_MAX_SYMBOL_BYTES = 50 * 1024 * 1024; // 50 MB
// Cap the number of per-bundle web/node source maps stored per release.
const MAX_WEB_MAPS_PER_RELEASE = 500;

const fieldValue = (data: MultipartFile, name: string): string | undefined => {
  const field = data.fields[name];
  return field && !Array.isArray(field) && field.type === 'field'
    ? (field.value as string)
    : undefined;
};

type StreamResult = { ok: true } | { ok: false; code: number; error: string };

// Stream the uploaded file to `dest` via a temp file + rename. Never buffers the
// whole upload in RAM; maps the too-large cases to 413.
const streamUploadToFile = async (
  req: FastifyRequest,
  data: MultipartFile,
  dest: string,
): Promise<StreamResult> => {
  const tmp = dest + '.tmp';
  try {
    await pipeline(data.file, createWriteStream(tmp));
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    if (
      data.file.truncated ||
      (err as { code?: string } | null)?.code === 'FST_REQ_FILE_TOO_LARGE'
    ) {
      return { ok: false, code: 413, error: 'file_too_large' };
    }
    req.log.error({ err }, 'symbol write failed');
    return { ok: false, code: 500, error: 'write_failed' };
  }
  // A truncated stream can complete without throwing when the limit is hit
  // exactly at EOF — treat that as too-large too.
  if (data.file.truncated) {
    await fs.unlink(tmp).catch(() => undefined);
    return { ok: false, code: 413, error: 'file_too_large' };
  }
  await fs.rename(tmp, dest);
  return { ok: true };
};

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

  // List uploaded web/node per-bundle source maps for a release, so the CLI can
  // report drift between the build's chunks and what was uploaded.
  app.get<{ Params: { id: string } }>(
    '/api/releases/:id/symbols',
    { preHandler },
    async (req, reply) => {
      const release = getReleaseById(db, req.params.id);
      if (!release) return reply.code(404).send({ error: 'release_not_found' });
      const maps = await listWebSymbolMaps(release.id);
      return { maps };
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

      const platform = fieldValue(data, 'platform');
      if (!platform) return reply.code(400).send({ error: 'missing_platform' });

      // --- web/node: per-bundle source map keyed by bundlePath ---
      if (isWebPlatform(platform)) {
        const rawBundlePath = fieldValue(data, 'bundlePath');
        const sanitized = sanitizeBundlePath(rawBundlePath);
        if (!sanitized.ok) {
          return reply.code(400).send({ error: 'invalid_bundlePath', reason: sanitized.reason });
        }

        // Enforce the per-release cap. Re-uploading an existing bundlePath is an
        // overwrite and does not count against the cap.
        const existing = await listWebSymbolMaps(release.id);
        const isOverwrite = existing.some(
          (m) => m.platform === platform && m.bundlePath === sanitized.path,
        );
        if (!isOverwrite && existing.length >= MAX_WEB_MAPS_PER_RELEASE) {
          return reply.code(409).send({ error: 'too_many_maps' });
        }

        const dest = webSymbolMapPath(release.id, platform, sanitized.path);
        // Defense-in-depth: the destination must stay under the platform dir.
        if (!isUnderDir(platformSymbolsDir(release.id, platform), dest)) {
          return reply.code(400).send({ error: 'invalid_bundlePath', reason: 'escapes_root' });
        }
        await fs.mkdir(path.dirname(dest), { recursive: true });

        const result = await streamUploadToFile(req, data, dest);
        if (!result.ok) return reply.code(result.code).send({ error: result.error });

        markSourcemapUploaded(db, release.id, Date.now());
        invalidateSymbolications(db, release.id);
        return { release: getReleaseById(db, release.id) };
      }

      // --- android: ProGuard mapping.txt or single Hermes sourcemap.map ---
      const isSourcemap = fieldValue(data, 'sourcemap') === 'true';

      await ensureSymbolsDir(release.id);
      const dest = isSourcemap ? sourcemapPath(release.id) : mappingPath(release.id);

      const result = await streamUploadToFile(req, data, dest);
      if (!result.ok) return reply.code(result.code).send({ error: result.error });

      const now = Date.now();
      if (isSourcemap) {
        markSourcemapUploaded(db, release.id, now);
      } else {
        markMappingUploaded(db, release.id, now);
      }
      invalidateSymbolications(db, release.id);

      return { release: getReleaseById(db, release.id) };
    },
  );
};

// Re-export path utility so server.ts can import from a single module
export { mappingPath, sourcemapPath } from './storage.js';
