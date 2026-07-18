import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertIssue } from '../db/repos/issues.js';
import { insertEvent } from '../db/repos/events.js';
import { insertBreadcrumbs } from '../db/repos/breadcrumbs.js';
import { upsertRelease, markSourcemapUploaded } from '../db/repos/releases.js';
import { webSymbolMapPath } from '../symbolication/web-symbols.js';
import { BUNDLE_MAX_BYTES, buildIssueBundle } from './bundle.js';
import type { ProjectRow } from '../db/schema.js';

let db: Db;
let close: () => void;
let tmpDir: string;
let project: ProjectRow;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  project = createProject(db, { name: 'App' });
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-bundle-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  close();
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A map with embedded content: generated (1,0) -> original (30,0) of `source`.
const CONTENT = Array.from({ length: 60 }, (_, i) => 'c'.repeat(300) + i).join('\n');
const contentMap = (source: string): string => {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 30, column: 0 }, source });
  gen.setSourceContent(source, CONTENT);
  return gen.toString();
};

const newWebRelease = () =>
  upsertRelease(db, { projectId: project.id, version: '2.0.0', build: '9', platform: 'web' });

const uploadMap = async (releaseId: string, bundlePath: string): Promise<void> => {
  const dest = webSymbolMapPath(releaseId, 'web', bundlePath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, contentMap('src/app.ts'));
  markSourcemapUploaded(db, releaseId, Date.now());
};

let fpN = 0;
const seedIssue = () => {
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${fpN++}`,
    title: 'TypeError: boom',
    ts: Date.now(),
    platform: 'web',
  });
  return issue;
};

const webPayload = (frames: object[]): string =>
  JSON.stringify({
    sdk: { name: '@uh-oh/js', version: '0.2.0' },
    timestamp: '2026-01-01T00:00:00.000Z',
    platform: 'web',
    release: { version: '2.0.0', build: '9' },
    level: 'error',
    exception: { type: 'TypeError', value: 'boom', stacktrace: frames, mechanism: 'js-global' },
    breadcrumbs: [],
    device: { osName: 'linux', osVersion: '1', deviceModel: 'server' },
  });

const seedEvent = (
  issueId: string,
  releaseId: string | null,
  frames: object[],
  opts: { user?: object | null; ts?: number } = {},
): string =>
  insertEvent(db, {
    projectId: project.id,
    issueId,
    releaseId,
    fingerprint: 'fp',
    level: 'error',
    platform: 'web',
    payload: webPayload(frames),
    receivedAt: opts.ts ?? Date.now(),
    deviceInfo: JSON.stringify({ osName: 'linux', osVersion: '1', deviceModel: 'server' }),
    userInfo:
      opts.user === undefined
        ? JSON.stringify({ id: 'u1' })
        : opts.user === null
          ? null
          : JSON.stringify(opts.user),
  }).id;

const frame = (inApp = true) => ({
  filename: 'https://h/static/chunks/main.js',
  function: 'render',
  lineno: 1,
  colno: 0,
  inApp,
});

describe('buildIssueBundle', () => {
  it('returns null for an unknown issue', async () => {
    expect(await buildIssueBundle(db, 'nope')).toBeNull();
  });

  it('assembles project, issue, impact, latest event, recent events and symbols', async () => {
    const release = newWebRelease();
    await uploadMap(release.id, 'static/chunks/main.js');
    const issue = seedIssue();
    const t0 = Date.now();
    seedEvent(issue.id, release.id, [frame()], { ts: t0 });
    seedEvent(issue.id, release.id, [frame()], { ts: t0 + 1, user: { id: 'u2' } });
    seedEvent(issue.id, release.id, [frame()], { ts: t0 + 2, user: { id: 'u2' } });
    seedEvent(issue.id, release.id, [frame()], { ts: t0 + 3 });

    const bundle = await buildIssueBundle(db, issue.id);
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    expect(bundle.project).toEqual({ id: project.id, name: project.name, slug: project.slug });
    expect(bundle.issue).toMatchObject({ id: issue.id, platform: 'web', status: 'open' });
    expect(bundle.impact.distinctUsers).toBe(2);
    expect(bundle.impact.platforms[0]).toEqual({ platform: 'web', events: 4 });

    // Latest event: symbolicated frame with source context + release label.
    expect(bundle.latestEvent?.release).toBe('2.0.0+9');
    expect(bundle.latestEvent?.exception).toMatchObject({ type: 'TypeError', value: 'boom' });
    expect(bundle.latestEvent?.frames[0]?.filename).toBe('src/app.ts');
    // Line 30 (idx 29) is 'c'*300 + '29' -> clipped to the 300-char cap.
    expect(bundle.latestEvent?.frames[0]?.context?.line).toBe('c'.repeat(300));

    // Recent events capped at 3.
    expect(bundle.recentEvents).toHaveLength(3);

    // Symbols reflect the uploaded web map.
    expect(bundle.symbols).toMatchObject({
      releaseId: release.id,
      platform: 'web',
      sourcemapUploaded: true,
      maps: { web: 1, node: 0 },
    });

    expect(bundle.truncated).toEqual({ context: false, breadcrumbs: false });
  });

  it('keeps only the last 20 breadcrumbs', async () => {
    const issue = seedIssue();
    const eventId = seedEvent(issue.id, null, [frame(false)]);
    insertBreadcrumbs(
      db,
      eventId,
      Array.from({ length: 25 }, (_, i) => ({
        ts: i,
        category: 'nav',
        level: 'info',
        message: `step ${i}`,
        data: null,
      })),
    );
    const bundle = await buildIssueBundle(db, issue.id);
    expect(bundle?.latestEvent?.breadcrumbs).toHaveLength(20);
    expect(bundle?.latestEvent?.breadcrumbs[0]?.message).toBe('step 5');
  });

  it('drops context first when over the size cap', async () => {
    const release = newWebRelease();
    await uploadMap(release.id, 'static/chunks/main.js');
    const issue = seedIssue();
    // 8 in-app frames each carry ~3.3KB of context (~26KB total).
    const frames = Array.from({ length: 8 }, () => frame(true));
    const eventId = seedEvent(issue.id, release.id, frames);
    // ~44KB of breadcrumbs — enough to exceed 64KB WITH context, but fit once
    // context is dropped.
    insertBreadcrumbs(
      db,
      eventId,
      Array.from({ length: 20 }, (_, i) => ({
        ts: i,
        category: 'net',
        level: 'info',
        message: 'm',
        data: JSON.stringify({ blob: 'y'.repeat(2200) }),
      })),
    );

    const bundle = await buildIssueBundle(db, issue.id);
    expect(bundle?.truncated).toEqual({ context: true, breadcrumbs: false });
    // Context stripped from every frame; breadcrumbs retained.
    expect(bundle?.latestEvent?.frames.every((f) => f.context === undefined)).toBe(true);
    expect(bundle?.latestEvent?.breadcrumbs.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
  });

  it('drops breadcrumbs too when context alone is not enough', async () => {
    const release = newWebRelease();
    await uploadMap(release.id, 'static/chunks/main.js');
    const issue = seedIssue();
    const frames = Array.from({ length: 8 }, () => frame(true));
    const eventId = seedEvent(issue.id, release.id, frames);
    // ~90KB of breadcrumbs — still over the cap after context is dropped.
    insertBreadcrumbs(
      db,
      eventId,
      Array.from({ length: 20 }, (_, i) => ({
        ts: i,
        category: 'net',
        level: 'info',
        message: 'm',
        data: JSON.stringify({ blob: 'z'.repeat(4500) }),
      })),
    );

    const bundle = await buildIssueBundle(db, issue.id);
    expect(bundle?.truncated).toEqual({ context: true, breadcrumbs: true });
    expect(bundle?.latestEvent?.breadcrumbs).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(BUNDLE_MAX_BYTES);
  });
});
