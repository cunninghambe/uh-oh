import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getIssue, setIssueStatus, upsertIssue } from '../db/repos/issues.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let project: ProjectRow;
let token: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  token = await mintTestToken(db);
});
afterEach(() => {
  close();
});

const authHeader = () => ({ authorization: `Bearer ${token}` });
const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });

const makeRegressedIssue = (fp = 'fp-reg'): string => {
  const { issue } = upsertIssue(db, { projectId: project.id, fingerprint: fp, title: 't', ts: 1 });
  setIssueStatus(db, issue.id, 'regressed');
  return issue.id;
};

describe('issues list — status=regressed filter', () => {
  it('returns regressed issues when filtered by status=regressed', async () => {
    const regressedId = makeRegressedIssue('a');
    upsertIssue(db, { projectId: project.id, fingerprint: 'b', title: 't', ts: 1 }); // open

    const res = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?status=regressed`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ issues: { id: string; status: string }[]; total: number }>();
    expect(body.total).toBe(1);
    expect(body.issues[0]?.id).toBe(regressedId);
    expect(body.issues[0]?.status).toBe('regressed');
  });
});

describe('PATCH /api/issues/:id — regressed is system-set', () => {
  it('rejects a user PATCH to status=regressed (400)', async () => {
    const { issue } = upsertIssue(db, {
      projectId: project.id,
      fingerprint: 'c',
      title: 't',
      ts: 1,
    });
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/issues/${issue.id}`,
      payload: { status: 'regressed' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_status');
  });

  it('allows PATCHing a regressed issue back to resolved (re-arms detection)', async () => {
    const regressedId = makeRegressedIssue('d');
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/issues/${regressedId}`,
      payload: { status: 'resolved' },
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ issue: { status: string } }>().issue.status).toBe('resolved');
    expect(getIssue(db, regressedId)?.status).toBe('resolved');
  });
});
