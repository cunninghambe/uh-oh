import type { AddressInfo } from 'node:net';

import { BackendError, HttpBackend } from '@uh-oh/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { cleanupExpiredSessions } from '../db/repos/sessions.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';

const PASSWORD = 'test-password';

let db: Db;
let close: () => void;
let app: ReturnType<typeof buildServer>;
let project: ProjectRow;
let baseUrl: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'My App' });
  app = buildServer({ db, secret: TEST_SECRET, password: PASSWORD });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await app.close();
  close();
});

describe('HttpBackend against a live server', () => {
  it('logs in and lists projects', async () => {
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const projects = await backend.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: project.id, slug: 'my-app' });
  });

  it('re-authenticates exactly once after the cached session is invalidated', async () => {
    let loginCount = 0;
    const countingFetch = (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/api/auth/login')) loginCount += 1;
      return fetch(url, init);
    };
    const backend = new HttpBackend({
      serverUrl: baseUrl,
      adminPassword: PASSWORD,
      fetchImpl: countingFetch,
    });

    await backend.listProjects();
    expect(loginCount).toBe(1);

    // Invalidate every session so the cached JWT's jti is gone → next call 401s.
    const deleted = cleanupExpiredSessions(db, Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    expect(deleted).toBeGreaterThan(0);

    const projects = await backend.listProjects();
    expect(projects).toHaveLength(1);
    expect(loginCount).toBe(2); // re-logged-in once, transparently
  });

  it('surfaces a server-side SSRF rejection (400) as a BackendError', async () => {
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    await expect(
      backend.updateProject({ projectId: project.id, webhookUrl: 'http://127.0.0.1:9/' }),
    ).rejects.toMatchObject({ code: 'invalid_webhookUrl', status: 400 });
  });

  it('maps a 404 to null for get_issue / get_event', async () => {
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    expect(await backend.getIssue({ issueId: 'missing' })).toBeNull();
    expect(await backend.getEvent({ eventId: 'missing', symbolicate: true })).toBeNull();
  });

  it('reports health with the parsed metrics subset', async () => {
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const health = await backend.getHealth();
    expect(health.ok).toBe(true);
    expect(health.metricsAvailable).toBe(true);
    expect(typeof health.eventsIngested).toBe('number');
  });

  it('aborts a slow request via the AbortController timeout', async () => {
    const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const backend = new HttpBackend({
      serverUrl: baseUrl,
      adminPassword: PASSWORD,
      fetchImpl: hangingFetch,
      timeoutMs: 25,
    });
    await expect(backend.listProjects()).rejects.toBeInstanceOf(BackendError);
    await expect(backend.listProjects()).rejects.toMatchObject({ code: 'timeout' });
  });
});
