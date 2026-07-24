// CONTRACT A (§23) — annotations, fix-attempt lifecycle, and similar issues, at
// the route level. Authorized with a JWT (full scope); the token scope matrix is
// covered in auth/agent-token.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getIssue, upsertIssue } from '../db/repos/issues.js';
import {
  MAX_ANNOTATIONS_PER_ISSUE,
  countAnnotations,
  createAnnotation,
} from '../db/repos/annotations.js';
import {
  applyFixAttemptTransition,
  listFixAttempts,
  upsertFixAttempt,
} from '../db/repos/fix-attempts.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';

let db: Db;
let close: () => void;
let token: string;
let projectId: string;
let issueId: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  token = await mintTestToken(db);
  const p = createProject(db, { name: 'App' });
  projectId = p.id;
  const { issue } = upsertIssue(db, {
    projectId,
    fingerprint: 'fp',
    title: 'TypeError: boom',
    ts: 1000,
    platform: 'web',
  });
  issueId = issue.id;
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const auth = () => ({ authorization: `Bearer ${token}` });

describe('annotations', () => {
  it('POST creates an annotation (201) and GET returns it newest-first with total', async () => {
    const a = app();
    const first = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
      payload: { body: 'first note' },
    });
    expect(first.statusCode).toBe(201);
    const ann = first.json<{
      annotation: { id: string; kind: string; author: string; body: string };
    }>().annotation;
    expect(ann).toMatchObject({ kind: 'note', author: 'agent', body: 'first note' });

    await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
      payload: { body: 'second note', kind: 'root_cause', author: 'triage-bot' },
    });

    const list = await a.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
    });
    const body = list.json<{ annotations: { body: string; kind: string }[]; total: number }>();
    expect(body.total).toBe(2);
    expect(body.annotations[0]?.body).toBe('second note'); // newest first
    expect(body.annotations[0]?.kind).toBe('root_cause');
    expect(body.annotations[1]?.body).toBe('first note');
  });

  it('rejects a bad kind (400), including the server-only "system" kind', async () => {
    const a = app();
    for (const kind of ['bogus', 'system']) {
      const res = await a.inject({
        method: 'POST',
        url: `/api/issues/${issueId}/annotations`,
        headers: auth(),
        payload: { body: 'x', kind },
      });
      expect(res.statusCode, kind).toBe(400);
    }
  });

  it('rejects an over-cap body with 413', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
      payload: { body: 'y'.repeat(16 * 1024 + 1) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('rejects a missing body (400) and an over-long author (400)', async () => {
    const a = app();
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/annotations`,
          headers: auth(),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/annotations`,
          headers: auth(),
          payload: { body: 'x', author: 'z'.repeat(129) },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('caps an author by BYTES, not characters (§23 "≤128")', async () => {
    const a = app();
    // 65 three-byte characters = 195 bytes but only 65 chars: accepted by the
    // old char-length check, rejected now.
    const multiByte = '中'.repeat(65);
    expect(multiByte.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(multiByte, 'utf8')).toBeGreaterThan(128);
    const res = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
      payload: { body: 'x', author: multiByte },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_author');

    // Exactly 128 bytes of multi-byte text still fits.
    const fits = 'é'.repeat(64); // 2 bytes each = 128
    expect(Buffer.byteLength(fits, 'utf8')).toBe(128);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/annotations`,
          headers: auth(),
          payload: { body: 'x', author: fits },
        })
      ).statusCode,
    ).toBe(201);
  });

  it('caps an issue at 500 client annotations, 409ing the 501st', async () => {
    const a = app();
    // Seed the cap directly (the route path is exercised by the 501st below).
    for (let i = 0; i < MAX_ANNOTATIONS_PER_ISSUE; i += 1) {
      createAnnotation(db, { issueId, body: `n${String(i)}` }, 1000 + i);
    }
    const res = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
      payload: { body: 'one too many' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('annotation_limit');
    expect(countAnnotations(db, issueId)).toBe(MAX_ANNOTATIONS_PER_ISSUE);

    // The server's own audit trail is exempt: a fix-attempt transition still
    // records its kind:'system' row on a capped issue.
    const { attempt } = upsertFixAttempt(db, { issueId, prUrl: 'https://gh/pr/cap' }, 1000);
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${attempt.id}`,
          headers: auth(),
          payload: { state: 'deployed' },
        })
      ).statusCode,
    ).toBe(200);
    expect(countAnnotations(db, issueId)).toBe(MAX_ANNOTATIONS_PER_ISSUE + 1);

    // A different issue is unaffected by the first issue's cap.
    const other = upsertIssue(db, {
      projectId,
      fingerprint: 'fp2',
      title: 'Error: other',
      ts: 1000,
    }).issue;
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${other.id}/annotations`,
          headers: auth(),
          payload: { body: 'fine' },
        })
      ).statusCode,
    ).toBe(201);
  });

  it('404s on an unknown issue', async () => {
    const a = app();
    expect(
      (await a.inject({ method: 'GET', url: `/api/issues/nope/annotations`, headers: auth() }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/nope/annotations`,
          headers: auth(),
          payload: { body: 'x' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('fix attempts', () => {
  it('upserts by (issue, prUrl): first is 201, re-record is 200 with the same id', async () => {
    const a = app();
    const first = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/fix-attempts`,
      headers: auth(),
      payload: { prUrl: 'https://gh/pr/1' },
    });
    expect(first.statusCode).toBe(201);
    const id = first.json<{ fixAttempt: { id: string; state: string } }>().fixAttempt.id;
    expect(first.json<{ fixAttempt: { state: string } }>().fixAttempt.state).toBe('filed');

    const again = await a.inject({
      method: 'POST',
      url: `/api/issues/${issueId}/fix-attempts`,
      headers: auth(),
      payload: { prUrl: 'https://gh/pr/1', commitSha: 'ABCDEF1' },
    });
    expect(again.statusCode).toBe(200);
    const re = again.json<{ fixAttempt: { id: string; commitSha: string } }>().fixAttempt;
    expect(re.id).toBe(id);
    expect(re.commitSha).toBe('abcdef1'); // lower-cased
  });

  it('rejects an invalid prUrl (400) and an invalid commitSha (400)', async () => {
    const a = app();
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/fix-attempts`,
          headers: auth(),
          payload: { prUrl: '' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await a.inject({
          method: 'POST',
          url: `/api/issues/${issueId}/fix-attempts`,
          headers: auth(),
          payload: { prUrl: 'https://gh/pr/1', commitSha: 'nothex!' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rejects a non-http(s) prUrl (400) because the dashboard renders it as an <a href>', async () => {
    const a = app();
    for (const prUrl of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/relative/pr/1',
      'gh/pr/1',
    ]) {
      const res = await a.inject({
        method: 'POST',
        url: `/api/issues/${issueId}/fix-attempts`,
        headers: auth(),
        payload: { prUrl },
      });
      expect(res.statusCode, prUrl).toBe(400);
      expect(res.json<{ error: string }>().error).toBe('invalid_prUrl');
    }
    // Nothing was stored.
    expect(listFixAttempts(db, issueId)).toHaveLength(0);

    // http and https both stay valid.
    for (const prUrl of ['https://github.com/o/r/pull/1', 'http://gh.internal.example/pr/2']) {
      expect(
        (
          await a.inject({
            method: 'POST',
            url: `/api/issues/${issueId}/fix-attempts`,
            headers: auth(),
            payload: { prUrl },
          })
        ).statusCode,
        prUrl,
      ).toBe(201);
    }
  });

  it('marking deployed resolves an open issue and stamps deployed_at + a system annotation', async () => {
    const a = app();
    const { attempt } = upsertFixAttempt(db, { issueId, prUrl: 'https://gh/pr/1' }, 1000);
    const res = await a.inject({
      method: 'PATCH',
      url: `/api/fix-attempts/${attempt.id}`,
      headers: auth(),
      payload: { state: 'deployed' },
    });
    expect(res.statusCode).toBe(200);
    const fa = res.json<{ fixAttempt: { state: string; deployedAt: number | null } }>().fixAttempt;
    expect(fa.state).toBe('deployed');
    expect(fa.deployedAt).not.toBeNull();
    // The issue (was open) is system-set resolved to re-arm regression detection.
    expect(getIssue(db, issueId)?.status).toBe('resolved');
    // A kind:'system' audit annotation was written.
    const list = await a.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/annotations`,
      headers: auth(),
    });
    expect(
      list.json<{ annotations: { kind: string }[] }>().annotations.some((x) => x.kind === 'system'),
    ).toBe(true);
  });

  it('permits filed->failed and deployed->failed, rejects invalid transitions (400)', async () => {
    const a = app();
    const mk = (pr: string) => upsertFixAttempt(db, { issueId, prUrl: pr }, 1000).attempt;

    // filed -> failed
    const f1 = mk('https://gh/pr/a');
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${f1.id}`,
          headers: auth(),
          payload: { state: 'failed' },
        })
      ).statusCode,
    ).toBe(200);

    // deployed -> failed
    const f2 = mk('https://gh/pr/b');
    applyFixAttemptTransition(db, f2, 'deployed', 1000);
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${f2.id}`,
          headers: auth(),
          payload: { state: 'failed' },
        })
      ).statusCode,
    ).toBe(200);

    // Invalid: filed -> verified (system-only), deployed -> filed, failed -> deployed.
    const f3 = mk('https://gh/pr/c');
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${f3.id}`,
          headers: auth(),
          payload: { state: 'verified' },
        })
      ).statusCode,
    ).toBe(400);
    const f4 = mk('https://gh/pr/d');
    applyFixAttemptTransition(db, f4, 'deployed', 1000);
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${f4.id}`,
          headers: auth(),
          payload: { state: 'filed' },
        })
      ).statusCode,
    ).toBe(400);
    const f5 = mk('https://gh/pr/e');
    applyFixAttemptTransition(db, f5, 'failed', 1000);
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/${f5.id}`,
          headers: auth(),
          payload: { state: 'deployed' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('PATCH 404s on an unknown attempt; the issue detail exposes fixAttempts newest-first', async () => {
    const a = app();
    expect(
      (
        await a.inject({
          method: 'PATCH',
          url: `/api/fix-attempts/ghost`,
          headers: auth(),
          payload: { state: 'deployed' },
        })
      ).statusCode,
    ).toBe(404);

    upsertFixAttempt(db, { issueId, prUrl: 'https://gh/pr/old' }, 1000);
    upsertFixAttempt(db, { issueId, prUrl: 'https://gh/pr/new' }, 2000);
    const detail = await a.inject({
      method: 'GET',
      url: `/api/issues/${issueId}`,
      headers: auth(),
    });
    const fixAttempts = detail.json<{ fixAttempts: { prUrl: string }[] }>().fixAttempts;
    expect(fixAttempts.map((f) => f.prUrl)).toEqual(['https://gh/pr/new', 'https://gh/pr/old']);
  });
});

describe('similar issues', () => {
  it('ranks fleet-wide by verified-fix, annotation count, then recency; excludes self', async () => {
    const a = app();
    const project2 = createProject(db, { name: 'Other' });

    const mkIssue = (pid: string, title: string, ts: number) =>
      upsertIssue(db, { projectId: pid, fingerprint: `fp-${title}`, title, ts, platform: 'web' })
        .issue;

    // B (project2) has a verified fix → ranks first regardless of the rest.
    const b = mkIssue(project2.id, 'TypeError: other', 2000);
    const bFix = upsertFixAttempt(db, { issueId: b.id, prUrl: 'https://gh/pr/b' }, 2000).attempt;
    applyFixAttemptTransition(db, bFix, 'verified', 2100);

    // C has 2 annotations, older last_seen.
    const c = mkIssue(projectId, 'TypeError: xyz', 3000);
    createAnnotation(db, { issueId: c.id, body: 'n1' }, 3001);
    createAnnotation(db, { issueId: c.id, body: 'n2' }, 3002);

    // D has nothing but the newest last_seen (proves annotation count outranks recency).
    const d = mkIssue(projectId, 'TypeError: zzz', 9000);

    // E has a different exception prefix → must NOT match.
    mkIssue(projectId, 'RangeError: boom', 9999);

    const res = await a.inject({
      method: 'GET',
      url: `/api/issues/${issueId}/similar`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const { similar } = res.json<{
      similar: {
        issue: { id: string; projectSlug: string; title: string; eventCount: number };
        fixAttempts: unknown[];
        annotationCount: number;
      }[];
    }>();

    expect(similar.map((s) => s.issue.id)).toEqual([b.id, c.id, d.id]);
    // Self and the RangeError issue are absent.
    expect(similar.map((s) => s.issue.id)).not.toContain(issueId);
    // Entry shape.
    expect(similar[0]?.issue).toMatchObject({
      id: b.id,
      projectSlug: 'other',
      title: 'TypeError: other',
    });
    expect(similar[0]?.fixAttempts).toHaveLength(1);
    expect(similar[1]?.annotationCount).toBe(2);
  });

  it('treats a title with no colon as a whole-title key', async () => {
    const a = app();
    const noColon = upsertIssue(db, {
      projectId,
      fingerprint: 'fp-oom',
      title: 'OutOfMemory',
      ts: 1000,
      platform: 'web',
    }).issue;
    upsertIssue(db, {
      projectId,
      fingerprint: 'fp-oom2',
      title: 'OutOfMemory',
      ts: 1001,
      platform: 'web',
    });
    const res = await a.inject({
      method: 'GET',
      url: `/api/issues/${noColon.id}/similar`,
      headers: auth(),
    });
    const { similar } = res.json<{ similar: { issue: { title: string } }[] }>();
    expect(similar).toHaveLength(1);
    expect(similar[0]?.issue.title).toBe('OutOfMemory');
  });
});
