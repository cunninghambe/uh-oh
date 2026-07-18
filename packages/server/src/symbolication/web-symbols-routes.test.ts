import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease } from '../db/repos/releases.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { symbolications } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';
import { webSymbolMapPath } from './web-symbols.js';

let db: Db;
let close: () => void;
let token: string;
let tmpDir: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  token = await mintTestToken(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-web-routes-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  close();
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const buildTestServer = (testDb: Db) =>
  buildServer({ db: testDb, secret: TEST_SECRET, password: 'test-password' });
const authHeader = () => ({ authorization: `Bearer ${token}` });

const mapContent = (): string => {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: 'src/orig.ts',
  });
  return gen.toString();
};

const BOUNDARY = '----TestBoundaryWEB';

const multipartBody = (
  filename: string,
  content: string,
  fields: Record<string, string>,
): Buffer => {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`--${BOUNDARY}`);
    lines.push(`Content-Disposition: form-data; name="${name}"`);
    lines.push('');
    lines.push(value);
  }
  lines.push(`--${BOUNDARY}`);
  lines.push(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
  lines.push('Content-Type: application/json');
  lines.push('');
  lines.push(content);
  lines.push(`--${BOUNDARY}--`);
  return Buffer.from(lines.join('\r\n'));
};

const postMap = (
  app: ReturnType<typeof buildServer>,
  releaseId: string,
  fields: Record<string, string>,
) =>
  app.inject({
    method: 'POST',
    url: `/api/releases/${releaseId}/symbols`,
    payload: multipartBody('bundle.js.map', mapContent(), fields),
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      ...authHeader(),
    },
  });

const newRelease = (platform: 'web' | 'node' = 'web') => {
  const project = createProject(db, { name: `p-${Math.random()}` });
  return upsertRelease(db, { projectId: project.id, version: '2.0.0', build: '9', platform });
};

describe('POST /api/releases/:id/symbols — web/node maps', () => {
  it('requires auth', async () => {
    const release = newRelease();
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/symbols`,
      payload: multipartBody('bundle.js.map', mapContent(), {
        platform: 'web',
        bundlePath: 'static/chunks/a.js',
      }),
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('stores a web map, sets sourcemap_uploaded_at, and writes to the platform dir', async () => {
    const release = newRelease('web');
    const app = buildTestServer(db);
    const res = await postMap(app, release.id, {
      platform: 'web',
      bundlePath: 'static/chunks/4bd1b696.js',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json<{ release: { sourcemapUploadedAt: number } }>();
    expect(json.release.sourcemapUploadedAt).toBeGreaterThan(0);

    const dest = path.join(tmpDir, release.id, 'web', 'static', 'chunks', '4bd1b696.js.map');
    expect((await fs.readFile(dest, 'utf8')).length).toBeGreaterThan(0);
  });

  it('stores a node map', async () => {
    const release = newRelease('node');
    const app = buildTestServer(db);
    const res = await postMap(app, release.id, {
      platform: 'node',
      bundlePath: '.next/server/app/page.js',
    });
    expect(res.statusCode).toBe(200);
    const dest = webSymbolMapPath(release.id, 'node', '.next/server/app/page.js');
    expect((await fs.readFile(dest, 'utf8')).length).toBeGreaterThan(0);
  });

  it('400 when bundlePath is missing', async () => {
    const release = newRelease('web');
    const app = buildTestServer(db);
    const res = await postMap(app, release.id, { platform: 'web' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_bundlePath');
  });

  it('400 (traversal) when bundlePath escapes the release dir', async () => {
    const release = newRelease('web');
    const app = buildTestServer(db);
    const res = await postMap(app, release.id, {
      platform: 'web',
      bundlePath: '../../etc/passwd',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ reason: string }>().reason).toBe('traversal');
    // Nothing was written outside (or inside) the release dir.
    await expect(fs.readFile(path.join(tmpDir, 'etc', 'passwd'))).rejects.toThrow();
  });

  it('400 (absolute) when bundlePath is absolute', async () => {
    const release = newRelease('web');
    const app = buildTestServer(db);
    const res = await postMap(app, release.id, { platform: 'web', bundlePath: '/etc/passwd' });
    expect(res.statusCode).toBe(400);
  });

  it('409 once the per-release cap (500) is exceeded; overwrite of an existing map still 200', async () => {
    const release = newRelease('web');
    // Pre-seed 500 maps directly on disk (fast path around the HTTP loop).
    for (let i = 0; i < 500; i++) {
      const dest = webSymbolMapPath(release.id, 'web', `static/chunks/c${String(i)}.js`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, '{}');
    }
    const app = buildTestServer(db);

    // A brand-new (501st) bundlePath is rejected.
    const over = await postMap(app, release.id, {
      platform: 'web',
      bundlePath: 'static/chunks/new.js',
    });
    expect(over.statusCode).toBe(409);
    expect(over.json<{ error: string }>().error).toBe('too_many_maps');

    // Overwriting one of the existing 500 is an overwrite, not a new map → 200.
    const overwrite = await postMap(app, release.id, {
      platform: 'web',
      bundlePath: 'static/chunks/c0.js',
    });
    expect(overwrite.statusCode).toBe(200);
  });

  it('upload invalidates cached symbolication rows for the release', async () => {
    const release = newRelease('web');
    const project = createProject(db, { name: 'evt' });
    const { issue } = upsertIssue(db, {
      projectId: project.id,
      fingerprint: 'fp',
      title: 't',
      ts: Date.now(),
    });
    const event = insertEvent(db, {
      projectId: project.id,
      issueId: issue.id,
      releaseId: release.id,
      fingerprint: 'fp',
      level: 'error',
      platform: 'web',
      payload: '{}',
      receivedAt: Date.now(),
      deviceInfo: '{}',
      userInfo: null,
    });
    db.insert(symbolications)
      .values({
        eventId: event.id,
        frameIdx: 0,
        resolved: JSON.stringify({ status: 'no_symbols' }),
      })
      .run();
    expect(db.select().from(symbolications).all()).toHaveLength(1);

    const app = buildTestServer(db);
    await postMap(app, release.id, { platform: 'web', bundlePath: 'static/chunks/a.js' });
    expect(db.select().from(symbolications).all()).toHaveLength(0);
  });
});

describe('GET /api/releases/:id/symbols', () => {
  it('requires auth', async () => {
    const release = newRelease();
    const app = buildTestServer(db);
    const res = await app.inject({ method: 'GET', url: `/api/releases/${release.id}/symbols` });
    expect(res.statusCode).toBe(401);
  });

  it('404 for an unknown release', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/releases/nope/symbols',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists uploaded maps as { platform, bundlePath, size }[]', async () => {
    const release = newRelease('web');
    const app = buildTestServer(db);
    await postMap(app, release.id, { platform: 'web', bundlePath: 'static/chunks/a.js' });
    await postMap(app, release.id, { platform: 'node', bundlePath: '.next/server/x.js' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/releases/${release.id}/symbols`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const { maps } = res.json<{
      maps: { platform: string; bundlePath: string; size: number }[];
    }>();
    expect(maps).toHaveLength(2);
    const byBundle = Object.fromEntries(maps.map((m) => [m.bundlePath, m]));
    expect(byBundle['static/chunks/a.js']?.platform).toBe('web');
    expect(byBundle['.next/server/x.js']?.platform).toBe('node');
    expect(byBundle['static/chunks/a.js']?.size).toBeGreaterThan(0);
  });

  it('returns an empty list before any upload', async () => {
    const release = newRelease();
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/releases/${release.id}/symbols`,
      headers: authHeader(),
    });
    expect(res.json<{ maps: unknown[] }>().maps).toEqual([]);
  });
});
