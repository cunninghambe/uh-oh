// §23 — the release upsert route (POST /api/projects/:id/releases) accepts an
// optional commitSha (validated, stored lower-case) and re-upserts update it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
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

const upsert = (a: ReturnType<typeof buildServer>, payload: Record<string, unknown>) =>
  a.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/releases`,
    headers: auth(),
    payload,
  });

describe('POST /api/projects/:id/releases — commitSha', () => {
  it('persists an uppercase commitSha lower-cased (201 on create)', async () => {
    const a = app();
    const res = await upsert(a, {
      version: '1.0.0',
      build: '1',
      platform: 'web',
      commitSha: 'ABCDEF1',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ release: { commitSha: string } }>().release.commitSha).toBe('abcdef1');
  });

  it('re-upsert with a different commitSha updates it (200)', async () => {
    const a = app();
    await upsert(a, { version: '1.0.0', build: '1', platform: 'web', commitSha: 'aaaaaaa' });
    const res = await upsert(a, {
      version: '1.0.0',
      build: '1',
      platform: 'web',
      commitSha: 'bbbbbbb',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ release: { commitSha: string } }>().release.commitSha).toBe('bbbbbbb');
  });

  it('rejects a malformed commitSha with 400', async () => {
    const a = app();
    const res = await upsert(a, {
      version: '1.0.0',
      build: '1',
      platform: 'web',
      commitSha: 'xyz',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a release with no commitSha (stays null)', async () => {
    const a = app();
    const res = await upsert(a, { version: '1.0.0', build: '1', platform: 'web' });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ release: { commitSha: string | null } }>().release.commitSha).toBeNull();
  });
});
