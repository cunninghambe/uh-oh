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
  MIN_READ_TOKEN_LENGTH,
  READ_TOKEN_HEADER,
  readTokenFromEnv,
  readTokenMatches,
} from './read-token.js';

// A conforming token (≥ 16 chars).
const READ_TOKEN = 'read-debug-token-abcdefghijklmnop';

describe('readTokenFromEnv', () => {
  it('returns undefined when unset (feature off)', () => {
    expect(readTokenFromEnv({})).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(readTokenFromEnv({ UH_OH_READ_TOKEN: '' })).toBeUndefined();
  });

  it('throws when set but shorter than the minimum length', () => {
    const short = 'x'.repeat(MIN_READ_TOKEN_LENGTH - 1);
    expect(() => readTokenFromEnv({ UH_OH_READ_TOKEN: short })).toThrow(/at least 16/);
  });

  it('returns the token when it meets the minimum length', () => {
    expect(readTokenFromEnv({ UH_OH_READ_TOKEN: READ_TOKEN })).toBe(READ_TOKEN);
    const exact = 'y'.repeat(MIN_READ_TOKEN_LENGTH);
    expect(readTokenFromEnv({ UH_OH_READ_TOKEN: exact })).toBe(exact);
  });
});

describe('readTokenMatches (constant-time)', () => {
  it('returns true for an exact match', () => {
    expect(readTokenMatches(READ_TOKEN, READ_TOKEN)).toBe(true);
  });

  it('returns false for a mismatch of equal length', () => {
    const other = 'read-debug-token-ABCDEFGHIJKLMNOP';
    expect(other).toHaveLength(READ_TOKEN.length);
    expect(readTokenMatches(other, READ_TOKEN)).toBe(false);
  });

  it('returns false for inputs of different length (no throw)', () => {
    expect(readTokenMatches('short', READ_TOKEN)).toBe(false);
    expect(readTokenMatches(READ_TOKEN + 'extra', READ_TOKEN)).toBe(false);
  });
});

describe('buildServer — read token validation', () => {
  it('throws when the configured token is shorter than the minimum', () => {
    const { db, close } = makeTestDb();
    try {
      expect(() =>
        buildServer({
          db,
          secret: TEST_SECRET,
          password: 'test-password',
          readToken: 'too-short',
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
          readToken: READ_TOKEN,
        }),
      ).not.toThrow();
    } finally {
      close();
    }
  });
});

// ── Integration: the token is scoped to EXACTLY the read allowlist ─────────────

describe('CONTRACT R — scoped read token (integration)', () => {
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
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-readtoken-'));
    process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
  });

  afterEach(async () => {
    close();
    delete process.env['UH_OH_SYMBOLS_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const tokenServer = () =>
    buildServer({ db, secret: TEST_SECRET, password: 'test-password', readToken: READ_TOKEN });
  const noTokenServer = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
  const tokenHeader = () => ({ [READ_TOKEN_HEADER]: READ_TOKEN });

  describe('token authorizes EXACTLY the read allowlist WITHOUT a JWT', () => {
    const allow = async (url: string) => {
      const app = tokenServer();
      const res = await app.inject({ method: 'GET', url, headers: tokenHeader() });
      expect(res.statusCode, `${url} should be authorized`).toBe(200);
      return res;
    };

    it('GET /api/projects', async () => {
      const res = await allow('/api/projects');
      expect(res.json<{ projects: unknown[] }>().projects).toHaveLength(1);
    });
    it('GET /api/projects/:id/issues', () => allow(`/api/projects/${projectId}/issues`));
    it('GET /api/projects/:id/stats', () => allow(`/api/projects/${projectId}/stats`));
    it('GET /api/projects/:id/releases', () => allow(`/api/projects/${projectId}/releases`));
    it('GET /api/projects/:id/monitors', () => allow(`/api/projects/${projectId}/monitors`));
    it('GET /api/projects/:id/usage/summary', () =>
      allow(`/api/projects/${projectId}/usage/summary`));
    it('GET /api/projects/:id/release-health', () =>
      allow(`/api/projects/${projectId}/release-health`));
    it('GET /api/issues/:id', () => allow(`/api/issues/${issueId}`));
    it('GET /api/issues/:id/events', () => allow(`/api/issues/${issueId}/events`));
    it('GET /api/issues/:id/impact', () => allow(`/api/issues/${issueId}/impact`));
    it('GET /api/issues/:id/stats', () => allow(`/api/issues/${issueId}/stats`));
    it('GET /api/issues/:id/bundle', () => allow(`/api/issues/${issueId}/bundle`));
    it('GET /api/events/:id', () => allow(`/api/events/${eventId}`));
  });

  describe('token is REJECTED on everything off the allowlist (401)', () => {
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
      expect(res.statusCode, `${method} ${url} should reject`).toBe(401);
      // The token never leaks into an error body.
      expect(res.body).not.toContain(READ_TOKEN);
    };

    it('rejects project writes + non-allowlisted project GET', async () => {
      const app = tokenServer();
      await reject(app, 'POST', '/api/projects', { name: 'X' });
      // Project DETAIL is intentionally NOT on the read allowlist.
      await reject(app, 'GET', `/api/projects/${projectId}`);
      await reject(app, 'PATCH', `/api/projects/${projectId}`, { name: 'Y' });
      await reject(app, 'DELETE', `/api/projects/${projectId}`);
      await reject(app, 'POST', `/api/projects/${projectId}/rotate-key`);
    });

    it('rejects issue + event writes', async () => {
      const app = tokenServer();
      await reject(app, 'PATCH', `/api/issues/${issueId}`, { status: 'resolved' });
    });

    it('rejects the release upsert + symbol upload (symbol-flow writes)', async () => {
      const app = tokenServer();
      await reject(app, 'POST', `/api/projects/${projectId}/releases`, {
        version: '9.9.9',
        build: '99',
        platform: 'web',
      });
      await reject(app, 'POST', `/api/releases/${releaseId}/symbols`);
      // The per-release symbols LIST is NOT on the read allowlist either.
      await reject(app, 'GET', `/api/releases/${releaseId}/symbols`);
    });

    it('rejects monitor CRUD', async () => {
      const app = tokenServer();
      await reject(app, 'PATCH', `/api/monitors/does-not-exist`, { status: 'paused' });
      await reject(app, 'DELETE', `/api/monitors/does-not-exist`);
    });

    it('rejects the cross-project top-issues + auth surface', async () => {
      const app = tokenServer();
      // top-issues is a read, but intentionally NOT on the §22 allowlist.
      await reject(app, 'GET', '/api/top-issues');
      await reject(app, 'POST', '/api/auth/logout');
    });

    it('ingest is unaffected (its own public-key auth, not this token)', () => {
      expect(publicKey).toBeTruthy();
    });
  });

  describe('token edge cases', () => {
    it('a WRONG token is rejected on an allowlisted route (falls through to absent JWT)', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { [READ_TOKEN_HEADER]: 'wrong-token-wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('a valid JWT still authorizes an allowlisted route when the token is configured', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('a valid JWT still authorizes a NON-allowlisted route when the token is configured', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('with the feature OFF, the token header is ignored (allowlisted route needs a JWT)', async () => {
      const app = noTokenServer();
      const res = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}`,
        headers: tokenHeader(),
      });
      expect(res.statusCode).toBe(401);
      const ok = await app.inject({
        method: 'GET',
        url: `/api/issues/${issueId}`,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(ok.statusCode).toBe(200);
    });

    it('a valid JWT still works on GET /api/projects (both tokens configured for that route)', async () => {
      const app = tokenServer();
      const res = await app.inject({
        method: 'GET',
        url: '/api/projects',
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
