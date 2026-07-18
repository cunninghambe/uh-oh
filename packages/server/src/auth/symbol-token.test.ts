import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease } from '../db/repos/releases.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from './test-utils.js';
import {
  MIN_SYMBOL_TOKEN_LENGTH,
  SYMBOL_TOKEN_HEADER,
  symbolTokenFromEnv,
  symbolTokenMatches,
} from './symbol-token.js';

// A conforming token (≥ 16 chars).
const SYMBOL_TOKEN = 'symbol-upload-token-abcdefghijklmnop';

describe('symbolTokenFromEnv', () => {
  it('returns undefined when unset (feature off)', () => {
    expect(symbolTokenFromEnv({})).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(symbolTokenFromEnv({ UH_OH_SYMBOL_TOKEN: '' })).toBeUndefined();
  });

  it('throws when set but shorter than the minimum length', () => {
    const short = 'x'.repeat(MIN_SYMBOL_TOKEN_LENGTH - 1);
    expect(() => symbolTokenFromEnv({ UH_OH_SYMBOL_TOKEN: short })).toThrow(/at least 16/);
  });

  it('returns the token when it meets the minimum length', () => {
    expect(symbolTokenFromEnv({ UH_OH_SYMBOL_TOKEN: SYMBOL_TOKEN })).toBe(SYMBOL_TOKEN);
    const exact = 'y'.repeat(MIN_SYMBOL_TOKEN_LENGTH);
    expect(symbolTokenFromEnv({ UH_OH_SYMBOL_TOKEN: exact })).toBe(exact);
  });
});

describe('symbolTokenMatches (constant-time)', () => {
  it('returns true for an exact match', () => {
    expect(symbolTokenMatches(SYMBOL_TOKEN, SYMBOL_TOKEN)).toBe(true);
  });

  it('returns false for a mismatch of equal length', () => {
    const other = 'symbol-upload-token-ABCDEFGHIJKLMNOP';
    expect(other).toHaveLength(SYMBOL_TOKEN.length);
    expect(symbolTokenMatches(other, SYMBOL_TOKEN)).toBe(false);
  });

  it('returns false for inputs of different length (no throw)', () => {
    expect(symbolTokenMatches('short', SYMBOL_TOKEN)).toBe(false);
    expect(symbolTokenMatches(SYMBOL_TOKEN + 'extra', SYMBOL_TOKEN)).toBe(false);
  });
});

describe('buildServer — symbol token validation', () => {
  it('throws when the configured token is shorter than the minimum', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() =>
        buildServer({
          db,
          secret: TEST_SECRET,
          password: 'test-password',
          symbolToken: 'too-short',
        }),
      ).toThrow(/at least 16/);
    } finally {
      close();
    }
  });

  it('boots with a conforming token', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() =>
        buildServer({
          db,
          secret: TEST_SECRET,
          password: 'test-password',
          symbolToken: SYMBOL_TOKEN,
        }),
      ).not.toThrow();
    } finally {
      close();
    }
  });
});

// ── Integration: the token is scoped to EXACTLY the upload-flow endpoints ──────

const MAPPING_TXT = `com.example.Foo -> a.b:
    void bar() -> c
`;

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
const MULTIPART_HEADER = { 'content-type': 'multipart/form-data; boundary=----TestBoundary1234' };

describe('CONTRACT T — scoped symbol-upload token (integration)', () => {
  let db: Db;
  let close: () => void;
  let jwt: string;
  let projectId: string;
  let publicKey: string;
  let releaseId: string;
  let issueId: string;
  let eventId: string;
  let tmpDir: string;

  beforeEach(async () => {
    ({ db, close } = makeTestDb());
    jwt = await mintTestToken(db);
    const project = createProject(db, { name: 'App' });
    projectId = project.id;
    publicKey = project.publicKey;
    const release = upsertRelease(db, {
      projectId,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    releaseId = release.id;
    const { issue } = upsertIssue(db, {
      projectId,
      fingerprint: 'fp',
      title: 't',
      ts: 1,
      platform: 'android',
    });
    issueId = issue.id;
    const event = insertEvent(db, {
      projectId,
      issueId,
      releaseId,
      fingerprint: 'fp',
      level: 'error',
      platform: 'android',
      payload: '{}',
      receivedAt: 1,
      deviceInfo: '{}',
      userInfo: null,
    });
    eventId = event.id;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-symtoken-'));
    process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
  });

  afterEach(async () => {
    close();
    delete process.env['UH_OH_SYMBOLS_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const tokenServer = () =>
    buildServer({ db, secret: TEST_SECRET, password: 'test-password', symbolToken: SYMBOL_TOKEN });
  const noTokenServer = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
  const tokenHeader = () => ({ [SYMBOL_TOKEN_HEADER]: SYMBOL_TOKEN });

  describe('token authorizes the upload-flow endpoints WITHOUT a JWT', () => {
    it('GET /api/projects', async () => {
      const app = tokenServer();
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: tokenHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ projects: unknown[] }>().projects).toHaveLength(1);
    });

    it('GET /api/projects/:id/releases', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/releases`,
        headers: tokenHeader(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ releases: unknown[] }>().releases).toHaveLength(1);
    });

    it('GET /api/releases/:id/symbols', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/releases/${releaseId}/symbols`,
        headers: tokenHeader(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ maps: unknown[] }>().maps).toEqual([]);
    });

    it('POST /api/releases/:id/symbols', async () => {
      const app = tokenServer();
      const body = makeMultipartBody('mapping.txt', MAPPING_TXT, { platform: 'android' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/releases/${releaseId}/symbols`,
        payload: body,
        headers: { ...MULTIPART_HEADER, ...tokenHeader() },
      });
      // Authorized AND accepted (not a 401/403).
      expect(res.statusCode).toBe(200);
    });

    it('POST /api/projects/:id/releases (release upsert)', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/releases`,
        payload: { version: '9.9.9', build: '99', platform: 'web' },
        headers: tokenHeader(),
      });
      // A new (version, build, platform) → 201, authorized via the token.
      expect(res.statusCode).toBe(201);
    });
  });

  describe('token is REJECTED on every non-upload route (401)', () => {
    const reject = async (
      app: ReturnType<typeof buildServer>,
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: Record<string, unknown>,
    ) => {
      const res = await app.inject({
        method,
        url,
        headers: tokenHeader(),
        ...(payload ? { payload } : {}),
      });
      expect(res.statusCode).toBe(401);
    };

    it('rejects project create/detail/mutation routes', async () => {
      const app = tokenServer();
      await reject(app, 'POST', '/api/projects', { name: 'X' });
      await reject(app, 'GET', `/api/projects/${projectId}`);
      await reject(app, 'PATCH', `/api/projects/${projectId}`, { name: 'Y' });
      await reject(app, 'DELETE', `/api/projects/${projectId}`);
      await reject(app, 'POST', `/api/projects/${projectId}/rotate-key`);
    });

    it('rejects issues routes', async () => {
      const app = tokenServer();
      await reject(app, 'GET', `/api/projects/${projectId}/issues`);
      await reject(app, 'GET', `/api/issues/${issueId}`);
      await reject(app, 'PATCH', `/api/issues/${issueId}`, { status: 'resolved' });
      await reject(app, 'GET', `/api/issues/${issueId}/events`);
      await reject(app, 'GET', `/api/issues/${issueId}/stats`);
    });

    it('rejects events routes', async () => {
      const app = tokenServer();
      await reject(app, 'GET', `/api/events/${eventId}`);
      await reject(app, 'GET', `/api/events/${eventId}?symbolicate=true`);
    });

    it('rejects auth + mcp routes', async () => {
      const app = tokenServer();
      await reject(app, 'POST', '/api/auth/logout');
      await reject(app, 'POST', '/mcp', { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    });

    it('rejects the ingest event by public key is unaffected (its own auth) but /api/* stats reject', async () => {
      const app = tokenServer();
      await reject(app, 'GET', `/api/projects/${projectId}/stats`);
      // Sanity: ingest uses the public key, not this token, and is not an /api/* route.
      expect(publicKey).toBeTruthy();
    });
  });

  describe('token edge cases', () => {
    it('a WRONG token is rejected on an upload route (falls through to absent JWT)', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { [SYMBOL_TOKEN_HEADER]: 'wrong-token-wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('a valid JWT still authorizes an upload route when the token is configured', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/releases`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('a valid JWT still authorizes a normal /api route when the token is configured', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('with the feature OFF, the token header is ignored (upload route needs a JWT)', async () => {
      const app = noTokenServer();
      const res = await app.inject({ method: 'GET', url: '/api/projects', headers: tokenHeader() });
      expect(res.statusCode).toBe(401);
      // But a JWT still works.
      const ok = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(ok.statusCode).toBe(200);
    });
  });
});
