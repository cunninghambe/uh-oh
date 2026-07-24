// §23 — projects.repo_url editable via PATCH /api/projects/:id (≤512, nullable to
// clear) and surfaced on the bundle; issue payloads expose spikeActive/lastSpikeAt.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let token: string;
let projectId: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  token = await mintTestToken(db);
  projectId = createProject(db, { name: 'App' }).id;
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const auth = () => ({ authorization: `Bearer ${token}` });

describe('PATCH /api/projects/:id — repoUrl', () => {
  it('sets, exposes on the bundle, and clears repoUrl', async () => {
    const a = app();
    const url = 'https://github.com/acme/app';

    const set = await a.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: auth(),
      payload: { repoUrl: url },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ project: { repoUrl: string } }>().project.repoUrl).toBe(url);

    // The bundle surfaces project.repoUrl.
    const { issue } = upsertIssue(db, {
      projectId,
      fingerprint: 'fp',
      title: 't',
      ts: 1,
      platform: 'web',
    });
    const bundle = await a.inject({
      method: 'GET',
      url: `/api/issues/${issue.id}/bundle`,
      headers: auth(),
    });
    expect(bundle.json<{ project: { repoUrl: string } }>().project.repoUrl).toBe(url);

    const cleared = await a.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: auth(),
      payload: { repoUrl: null },
    });
    expect(cleared.json<{ project: { repoUrl: string | null } }>().project.repoUrl).toBeNull();
  });

  it('rejects a repoUrl longer than 512 chars (400)', async () => {
    const a = app();
    const res = await a.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}`,
      headers: auth(),
      payload: { repoUrl: 'x'.repeat(513) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('issue payloads expose spikeActive / lastSpikeAt', () => {
  it('defaults to false / null on the detail and list', async () => {
    const a = app();
    const { issue } = upsertIssue(db, {
      projectId,
      fingerprint: 'fp',
      title: 't',
      ts: 1,
      platform: 'web',
    });
    const detail = await a.inject({
      method: 'GET',
      url: `/api/issues/${issue.id}`,
      headers: auth(),
    });
    const dIssue = detail.json<{ issue: { spikeActive: boolean; lastSpikeAt: number | null } }>()
      .issue;
    expect(dIssue.spikeActive).toBe(false);
    expect(dIssue.lastSpikeAt).toBeNull();

    const list = await a.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/issues`,
      headers: auth(),
    });
    const rows = list.json<{ issues: { spikeActive: boolean }[] }>().issues;
    expect(rows[0]?.spikeActive).toBe(false);
  });
});
