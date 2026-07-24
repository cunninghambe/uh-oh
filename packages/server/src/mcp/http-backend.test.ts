import type { AddressInfo } from 'node:net';

import { BackendError, HttpBackend } from '@uh-oh/mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EventEnvelope } from '@uh-oh/types';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { createMonitor } from '../db/repos/monitors.js';
import { insertUsageEvent } from '../db/repos/usage.js';
import { cleanupExpiredSessions } from '../db/repos/sessions.js';
import { ingest } from '../ingest/ingest.js';
import { createRateLimiter } from '../ingest/rate-limit.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { TEST_SECRET } from '../auth/test-utils.js';

const ENVELOPE: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.1.0' },
  timestamp: '2026-07-01T00:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'Error',
    value: 'boom',
    mechanism: 'js-global',
    stacktrace: [{ module: 'A', function: 'f', inApp: true }],
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14', deviceModel: 'Pixel' },
};

const seedIssue = (): string => {
  const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
  const res = ingest({ db, rateLimiter: rl }, project.publicKey, ENVELOPE);
  if (res.kind !== 'stored') throw new Error(`seed failed: ${res.kind}`);
  return res.issueId;
};

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

  it('fetches an issue bundle (and maps a missing issue to null)', async () => {
    const issueId = seedIssue();
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const bundle = await backend.getIssueBundle({ issueId });
    expect(bundle?.issue.id).toBe(issueId);
    expect(bundle?.project.slug).toBe('my-app');
    expect(bundle?.truncated).toEqual({ context: false, breadcrumbs: false, annotations: false });
    expect(await backend.getIssueBundle({ issueId: 'missing' })).toBeNull();
  });

  it('lists top issues across projects', async () => {
    const issueId = seedIssue();
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const top = await backend.listTopIssues({ limit: 10, days: 14 });
    expect(top[0]).toMatchObject({ issueId, projectSlug: 'my-app', platform: 'android' });
  });

  it('lists monitors globally and scoped to a project', async () => {
    createMonitor(db, {
      projectId: project.id,
      slug: 'nightly',
      intervalMinutes: 10,
      graceMinutes: 5,
      now: Date.now() - 60 * 60_000,
    });
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const all = await backend.listMonitors({});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ slug: 'nightly', projectSlug: 'my-app', overdue: true });
    const scoped = await backend.listMonitors({ projectId: project.id });
    expect(scoped).toHaveLength(1);
  });

  it('fetches the usage summary over the API route', async () => {
    insertUsageEvent(db, {
      projectId: project.id,
      type: 'pageview',
      name: null,
      path: '/home',
      referrerDomain: 'google.com',
      visitor: 'v1',
      props: null,
      receivedAt: Date.now(),
    });
    const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
    const summary = await backend.getUsageSummary({ projectId: project.id, days: 7 });
    expect(summary.days).toHaveLength(7);
    expect(summary.totals).toEqual({ pageviews: 1, visitors: 1, events: 0 });
    expect(summary.topReferrers[0]).toEqual({ referrer: 'google.com', pageviews: 1 });
  });

  describe('v0.8 agent-loop (§23)', () => {
    it('creates an annotation and rejects the system kind (the server 400)', async () => {
      const issueId = seedIssue();
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      const annotation = await backend.createAnnotation({
        issueId,
        body: 'root cause found',
        kind: 'root_cause',
      });
      expect(annotation).toMatchObject({ issueId, kind: 'root_cause', body: 'root cause found' });

      // The tool's zod schema already blocks 'system' before this backend is
      // reached; bypass it here to prove the HTTP route rejects it too (400).
      await expect(
        backend.createAnnotation({
          issueId,
          body: 'nope',
          kind: 'system' as unknown as never,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('createAnnotation 404s for an unknown issue', async () => {
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      await expect(
        backend.createAnnotation({ issueId: 'missing', body: 'x' }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('upserts a fix attempt then transitions it to deployed, resolving the issue', async () => {
      const issueId = seedIssue();
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      const filed = await backend.upsertFixAttempt({
        issueId,
        prUrl: 'https://github.com/org/repo/pull/1',
      });
      expect(filed).toMatchObject({
        issueId,
        prUrl: 'https://github.com/org/repo/pull/1',
        state: 'filed',
      });

      const deployed = await backend.transitionFixAttempt({
        fixAttemptId: filed.id,
        state: 'deployed',
      });
      expect(deployed).toMatchObject({ id: filed.id, state: 'deployed' });
      expect(deployed.deployedAt).not.toBeNull();

      const issueBackend = await backend.getIssue({ issueId });
      expect(issueBackend?.issue.status).toBe('resolved');
    });

    it('surfaces an invalid transition (the server 400) as a BackendError', async () => {
      const issueId = seedIssue();
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      const filed = await backend.upsertFixAttempt({ issueId, prUrl: 'https://gh/pr/2' });
      await backend.transitionFixAttempt({ fixAttemptId: filed.id, state: 'failed' });
      // failed -> deployed is not an allowed transition.
      await expect(
        backend.transitionFixAttempt({ fixAttemptId: filed.id, state: 'deployed' }),
      ).rejects.toMatchObject({ code: 'invalid_transition', status: 400 });
    });

    it('upsertFixAttempt 404s for an unknown issue', async () => {
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      await expect(
        backend.upsertFixAttempt({ issueId: 'missing', prUrl: 'https://gh/pr/1' }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('lists similar issues sharing the exception-type prefix, ranked by verified-fix and recency', async () => {
      const issueId = seedIssue();
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      // A second event under a distinct fingerprint creates a second issue with
      // the same exception-type prefix ('Error') in the same project — the
      // title is `${type}: ${value} at ${where}`, so the prefix (text before
      // the first ':') matches even though the message differs.
      const rl = createRateLimiter({ capacity: 10, refillPerSec: 1 });
      const second = ingest({ db, rateLimiter: rl }, project.publicKey, {
        ...ENVELOPE,
        fingerprint: ['distinct-issue'],
        exception: { ...ENVELOPE.exception, value: 'a different message' },
      });
      if (second.kind !== 'stored') throw new Error(`seed failed: ${second.kind}`);

      const similar = await backend.listSimilarIssues({ issueId });
      expect(similar).not.toBeNull();
      expect(similar?.some((s) => s.issue.id === second.issueId)).toBe(true);
    });

    it('listSimilarIssues resolves to null for an unknown issue', async () => {
      const backend = new HttpBackend({ serverUrl: baseUrl, adminPassword: PASSWORD });
      expect(await backend.listSimilarIssues({ issueId: 'missing' })).toBeNull();
    });
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
