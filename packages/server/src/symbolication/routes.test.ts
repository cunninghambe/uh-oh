import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease } from '../db/repos/releases.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { symbolications } from '../db/schema.js';

const MAPPING_TXT = `com.example.Foo -> a.b:
    void bar() -> c
`;

let db: Db;
let close: () => void;
let token: string;
let tmpDir: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  token = await mintTestToken(db);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-routes-test-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  close();
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const buildTestServer = (testDb: Db) => buildServer({ db: testDb, secret: TEST_SECRET });
const authHeader = () => ({ authorization: `Bearer ${token}` });

const makeMultipartBody = (
  filename: string,
  content: string,
  extraFields: Record<string, string> = {},
): Buffer => {
  const boundary = '----TestBoundary1234';
  const lines: string[] = [];

  for (const [name, value] of Object.entries(extraFields)) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Disposition: form-data; name="${name}"`);
    lines.push('');
    lines.push(value);
  }

  lines.push(`--${boundary}`);
  lines.push(`Content-Disposition: form-data; name="file"; filename="${filename}"`);
  lines.push('Content-Type: text/plain');
  lines.push('');
  lines.push(content);
  lines.push(`--${boundary}--`);

  return Buffer.from(lines.join('\r\n'));
};

describe('POST /api/releases/:id/symbols', () => {
  it('requires auth', async () => {
    const project = createProject(db, { name: 'App' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const app = buildTestServer(db);
    const body = makeMultipartBody('mapping.txt', MAPPING_TXT, { platform: 'android' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/symbols`,
      payload: body,
      headers: { 'content-type': 'multipart/form-data; boundary=----TestBoundary1234' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when release not found', async () => {
    const app = buildTestServer(db);
    const body = makeMultipartBody('mapping.txt', MAPPING_TXT, { platform: 'android' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/releases/no-such-release/symbols',
      payload: body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----TestBoundary1234',
        ...authHeader(),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 when platform field is missing', async () => {
    const project = createProject(db, { name: 'App' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const app = buildTestServer(db);
    // No platform field
    const body = makeMultipartBody('mapping.txt', MAPPING_TXT);
    const res = await app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/symbols`,
      payload: body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----TestBoundary1234',
        ...authHeader(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('happy path: writes file and sets mapping_uploaded_at', async () => {
    const project = createProject(db, { name: 'App' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const app = buildTestServer(db);
    const body = makeMultipartBody('mapping.txt', MAPPING_TXT, { platform: 'android' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/symbols`,
      payload: body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----TestBoundary1234',
        ...authHeader(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body2 = res.json<{ release: { mappingUploadedAt: number } }>();
    expect(body2.release.mappingUploadedAt).toBeGreaterThan(0);

    // Verify file was written
    const filePath = path.join(tmpDir, release.id, 'mapping.txt');
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toContain('com.example.Foo');
  });

  it('upload invalidates existing symbolication cache', async () => {
    const project = createProject(db, { name: 'App' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
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
      platform: 'android',
      payload: '{}',
      receivedAt: Date.now(),
      deviceInfo: '{}',
      userInfo: null,
    });
    // Seed a cached symbolication row
    db.insert(symbolications)
      .values({
        eventId: event.id,
        frameIdx: 0,
        resolved: JSON.stringify({ status: 'ok', module: 'old' }),
      })
      .run();

    const countBefore = db.select().from(symbolications).all().length;
    expect(countBefore).toBe(1);

    const app = buildTestServer(db);
    const body = makeMultipartBody('mapping.txt', MAPPING_TXT, { platform: 'android' });
    await app.inject({
      method: 'POST',
      url: `/api/releases/${release.id}/symbols`,
      payload: body,
      headers: {
        'content-type': 'multipart/form-data; boundary=----TestBoundary1234',
        ...authHeader(),
      },
    });

    const countAfter = db.select().from(symbolications).all().length;
    expect(countAfter).toBe(0);
  });
});

describe('GET /api/projects/:id/releases', () => {
  it('requires auth', async () => {
    const project = createProject(db, { name: 'App' });
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/releases`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 when project not found', async () => {
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/no-such/releases',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns releases for project', async () => {
    const project = createProject(db, { name: 'App' });
    upsertRelease(db, { projectId: project.id, version: '1.0.0', build: '1', platform: 'android' });
    upsertRelease(db, { projectId: project.id, version: '1.0.1', build: '2', platform: 'android' });
    const app = buildTestServer(db);
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/releases`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ releases: unknown[] }>();
    expect(body.releases).toHaveLength(2);
  });
});
