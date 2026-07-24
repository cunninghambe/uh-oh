// §24 — issue merge. POST /api/issues/:id/merge (JWT only) folds a source issue
// into a target atomically: events/annotations/fix-attempts move, the target's
// counts recompute, the source's fingerprint routes future ingest to the target,
// the source hides from default lists, becomes un-PATCHable, and merge-into-merged
// (and the other validation violations) are rejected.

import type { EventEnvelope } from '@uh-oh/types';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { getIssue, listIssues } from '../db/repos/issues.js';
import { listEventsForIssue } from '../db/repos/events.js';
import { createAnnotation, listAnnotations } from '../db/repos/annotations.js';
import { upsertFixAttempt, listFixAttempts } from '../db/repos/fix-attempts.js';
import { getAliasTarget } from '../db/repos/fingerprint-aliases.js';
import { ingest as ingestFn, type IngestResult } from '../ingest/ingest.js';
import { createRateLimiter } from '../ingest/rate-limit.js';
import type { ProjectRow } from '../db/schema.js';
import { buildServer } from '../server.js';
import { mintTestToken, TEST_SECRET } from '../auth/test-utils.js';
import { metrics } from '../metrics/registry.js';

let db: Db;
let close: () => void;
let project: ProjectRow;
let token: string;

const rl = createRateLimiter({ capacity: 10_000, refillPerSec: 1000 });

const base: EventEnvelope = {
  sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
  timestamp: '2026-05-16T12:00:00.000Z',
  platform: 'android',
  release: { version: '1.0.0', build: '1' },
  level: 'error',
  exception: {
    type: 'TypeError',
    value: 'x',
    stacktrace: [{ module: 'src/App.tsx', function: 'render', inApp: true }],
    mechanism: 'js-global',
  },
  breadcrumbs: [],
  device: { osName: 'Android', osVersion: '14' },
};

// The fingerprint is `${type}::src/App.tsx:render`, so `type` selects the issue.
const ingest = (type: string, publicKey = project.publicKey): IngestResult =>
  ingestFn({ db, rateLimiter: rl }, publicKey, {
    ...base,
    exception: { ...base.exception, type },
  });

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  token = await mintTestToken(db);
});
afterEach(() => close());

const app = () => buildServer({ db, secret: TEST_SECRET, password: 'test-password' });
const auth = () => ({ authorization: `Bearer ${token}` });

const storedIssueId = (r: IngestResult): string => {
  if (r.kind !== 'stored') throw new Error(`expected stored, got ${r.kind}`);
  return r.issueId;
};

const merge = (sourceId: string, into: unknown) =>
  app().inject({
    method: 'POST',
    url: `/api/issues/${sourceId}/merge`,
    headers: auth(),
    payload: { into },
  });

describe('POST /api/issues/:id/merge — happy path', () => {
  it('moves events, annotations, and fix attempts atomically and recomputes the target', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    storedIssueId(ingest('AError'));
    storedIssueId(ingest('AError')); // source: 3 events
    const targetId = storedIssueId(ingest('BError'));
    storedIssueId(ingest('BError')); // target: 2 events

    createAnnotation(
      db,
      { issueId: sourceId, body: 'root cause on source', kind: 'root_cause' },
      1,
    );
    createAnnotation(db, { issueId: targetId, body: 'note on target' }, 1);
    upsertFixAttempt(db, { issueId: sourceId, prUrl: 'https://gh/pr/source' }, 1);
    upsertFixAttempt(db, { issueId: targetId, prUrl: 'https://gh/pr/target' }, 1);

    const before = (await metrics.issuesMerged.get()).values.reduce((s, v) => s + v.value, 0);

    const res = await merge(sourceId, targetId);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ merged: boolean; mergedInto: string }>()).toMatchObject({
      merged: true,
      mergedInto: targetId,
    });

    // Target recomputed to 5 events; source drained to 0.
    expect(getIssue(db, targetId)?.eventCount).toBe(5);
    expect(listEventsForIssue(db, targetId).total).toBe(5);
    expect(listEventsForIssue(db, sourceId).total).toBe(0);

    // Annotations moved to the target, plus the system "merged from" record.
    expect(listAnnotations(db, sourceId).total).toBe(0);
    const targetAnnos = listAnnotations(db, targetId);
    expect(targetAnnos.rows.some((a) => a.body === 'root cause on source')).toBe(true);
    expect(
      targetAnnos.rows.some((a) => a.kind === 'system' && a.body.includes('merged from')),
    ).toBe(true);

    // Fix attempts moved to the target.
    expect(listFixAttempts(db, sourceId)).toHaveLength(0);
    expect(
      listFixAttempts(db, targetId)
        .map((f) => f.prUrl)
        .sort(),
    ).toEqual(['https://gh/pr/source', 'https://gh/pr/target']);

    // Source is terminal, with an alias for its fingerprint pointing at the target.
    expect(getIssue(db, sourceId)?.status).toBe('merged');
    expect(getAliasTarget(db, project.id, 'AError::src/App.tsx:render')).toBe(targetId);

    const after = (await metrics.issuesMerged.get()).values.reduce((s, v) => s + v.value, 0);
    expect(after - before).toBe(1);
  });

  it('combines counters ADDITIVELY so rate-limited counts without event rows survive the merge (edge case 4)', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));

    // Simulate token-bucket floods: counters bumped far past the stored rows
    // (rate-limited ingest increments event_count but skips the event insert).
    db.run(sql`UPDATE issues SET event_count = 40 WHERE id = ${sourceId}`);
    db.run(sql`UPDATE issues SET event_count = 60 WHERE id = ${targetId}`);

    const res = await merge(sourceId, targetId);
    expect(res.statusCode).toBe(200);

    // 40 + 60 = 100 — a row recount would have collapsed this to 2.
    expect(getIssue(db, targetId)?.eventCount).toBe(100);
    expect(listEventsForIssue(db, targetId).total).toBe(2);
  });

  it('routes the next ingest of the source fingerprint to the target (no resurrection)', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));
    expect((await merge(sourceId, targetId)).statusCode).toBe(200);

    const issuesBefore = listIssues(db, { projectId: project.id }).total;
    const r = ingest('AError');
    expect(r.kind).toBe('stored');
    if (r.kind !== 'stored') throw new Error('unreachable');
    // Routed to the target, not a new/merged issue.
    expect(r.issueId).toBe(targetId);
    expect(r.isNewIssue).toBe(false);
    // Target held 2 after the merge (its own + the moved source event); the
    // re-routed ingest bumps it to 3.
    expect(getIssue(db, targetId)?.eventCount).toBe(3);
    // No new issue was created.
    expect(listIssues(db, { projectId: project.id }).total).toBe(issuesBefore);
  });

  it('dedupes a fix-attempt PR shared by source and target (no UNIQUE crash)', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));
    upsertFixAttempt(db, { issueId: sourceId, prUrl: 'https://gh/pr/shared' }, 1);
    upsertFixAttempt(db, { issueId: targetId, prUrl: 'https://gh/pr/shared' }, 1);
    expect((await merge(sourceId, targetId)).statusCode).toBe(200);
    expect(
      listFixAttempts(db, targetId).filter((f) => f.prUrl === 'https://gh/pr/shared'),
    ).toHaveLength(1);
    expect(listFixAttempts(db, sourceId)).toHaveLength(0);
  });
});

describe('merged issue visibility + immutability', () => {
  const seedMerged = async (): Promise<{ sourceId: string; targetId: string }> => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));
    await merge(sourceId, targetId);
    return { sourceId, targetId };
  };

  it('hides the merged source from default lists but shows it under status=merged', async () => {
    const { sourceId } = await seedMerged();
    const def = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues`,
      headers: auth(),
    });
    const defIds = def.json<{ issues: { id: string }[] }>().issues.map((i) => i.id);
    expect(defIds).not.toContain(sourceId);

    const merged = await app().inject({
      method: 'GET',
      url: `/api/projects/${project.id}/issues?status=merged`,
      headers: auth(),
    });
    const mergedIds = merged.json<{ issues: { id: string }[] }>().issues.map((i) => i.id);
    expect(mergedIds).toContain(sourceId);
  });

  it("exposes the target via the merged source's detail mergedInto pointer", async () => {
    const { sourceId, targetId } = await seedMerged();
    const res = await app().inject({
      method: 'GET',
      url: `/api/issues/${sourceId}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ issue: { status: string }; mergedInto: string | null }>()).toMatchObject({
      issue: { status: 'merged' },
      mergedInto: targetId,
    });
  });

  it('rejects PATCH of a merged issue with 409', async () => {
    const { sourceId } = await seedMerged();
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/issues/${sourceId}`,
      headers: auth(),
      payload: { status: 'open' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('issue_merged');
  });
});

describe('merge validation', () => {
  it('requires a JWT', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));
    const res = await app().inject({
      method: 'POST',
      url: `/api/issues/${sourceId}/merge`,
      payload: { into: targetId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s an unknown source or target', async () => {
    const targetId = storedIssueId(ingest('BError'));
    expect((await merge('nope', targetId)).statusCode).toBe(404);
    const sourceId = storedIssueId(ingest('AError'));
    const res = await merge(sourceId, 'nope');
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('target_not_found');
  });

  it('400s a missing target, self-merge, and cross-project merge', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    expect((await merge(sourceId, undefined)).statusCode).toBe(400);
    const self = await merge(sourceId, sourceId);
    expect(self.statusCode).toBe(400);
    expect(self.json<{ error: string }>().error).toBe('cannot_merge_into_self');

    const other = createProject(db, { name: 'Other' });
    const foreignId = storedIssueId(ingest('BError', other.publicKey));
    const cross = await merge(sourceId, foreignId);
    expect(cross.statusCode).toBe(400);
    expect(cross.json<{ error: string }>().error).toBe('cross_project_merge');
  });

  it('400s merging into a merged issue and re-merging a merged source', async () => {
    const sourceId = storedIssueId(ingest('AError'));
    const targetId = storedIssueId(ingest('BError'));
    const thirdId = storedIssueId(ingest('CError'));
    expect((await merge(sourceId, targetId)).statusCode).toBe(200);

    // sourceId is now merged: cannot be a target...
    const intoMerged = await merge(thirdId, sourceId);
    expect(intoMerged.statusCode).toBe(400);
    expect(intoMerged.json<{ error: string }>().error).toBe('target_merged');

    // ...nor a source again.
    const reMerge = await merge(sourceId, targetId);
    expect(reMerge.statusCode).toBe(400);
    expect(reMerge.json<{ error: string }>().error).toBe('source_already_merged');
  });
});
