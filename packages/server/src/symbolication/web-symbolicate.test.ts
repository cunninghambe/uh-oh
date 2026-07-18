import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease, markSourcemapUploaded } from '../db/repos/releases.js';
import { insertEvent } from '../db/repos/events.js';
import { upsertIssue } from '../db/repos/issues.js';
import { symbolicateEvent } from './symbolicate.js';
import { webSymbolMapPath } from './web-symbols.js';

let db: Db;
let close: () => void;
let tmpDir: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-web-sym-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  close();
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const buildMap = (source: string, name?: string): string => {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 42, column: 4 },
    source,
    ...(name !== undefined ? { name } : {}),
  });
  return gen.toString();
};

const makePayload = (platform: 'web' | 'node', frames: object[]): string =>
  JSON.stringify({
    sdk: { name: '@uh-oh/js', version: '0.2.0' },
    timestamp: '2026-01-01T00:00:00.000Z',
    platform,
    release: { version: '2.0.0', build: '9' },
    level: 'error',
    exception: { type: 'Error', value: 'boom', stacktrace: frames, mechanism: 'js-global' },
    breadcrumbs: [],
    device: { osName: 'linux', osVersion: '1' },
  });

const seedWebEvent = (
  releaseId: string | null,
  platform: 'web' | 'node',
  frames: object[],
): string => {
  const project = createProject(db, { name: `p-${Math.random()}` });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${Math.random()}`,
    title: 't',
    ts: Date.now(),
  });
  return insertEvent(db, {
    projectId: project.id,
    issueId: issue.id,
    releaseId,
    fingerprint: 'fp',
    level: 'error',
    platform,
    payload: makePayload(platform, frames),
    receivedAt: Date.now(),
    deviceInfo: '{}',
    userInfo: null,
  }).id;
};

const uploadMap = async (
  releaseId: string,
  platform: 'web' | 'node',
  bundlePath: string,
  raw: string,
) => {
  const dest = webSymbolMapPath(releaseId, platform, bundlePath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, raw);
  markSourcemapUploaded(db, releaseId, Date.now());
};

const newRelease = (platform: 'web' | 'node') => {
  const project = createProject(db, { name: `rel-${Math.random()}` });
  return upsertRelease(db, { projectId: project.id, version: '2.0.0', build: '9', platform });
};

describe('symbolicateEvent — web/node per-bundle source maps', () => {
  it('resolves a web frame (full URL filename) via matched bundle map', async () => {
    const release = newRelease('web');
    await uploadMap(
      release.id,
      'web',
      'static/chunks/main.js',
      buildMap('src/app.ts', 'handleClick'),
    );
    const eventId = seedWebEvent(release.id, 'web', [
      {
        filename: 'https://app.example.com/_next/static/chunks/main.js',
        function: 'a',
        lineno: 1,
        colno: 0,
        inApp: true,
      },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.filename).toBe('src/app.ts');
    expect(frames[0]?.lineno).toBe(42);
    expect(frames[0]?.function).toBe('handleClick');
  });

  it('resolves a node frame (file:// filename)', async () => {
    const release = newRelease('node');
    await uploadMap(release.id, 'node', '.next/server/app/page.js', buildMap('src/page.tsx'));
    const eventId = seedWebEvent(release.id, 'node', [
      {
        filename: 'file:///srv/app/.next/server/app/page.js',
        lineno: 1,
        colno: 0,
        inApp: true,
      },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.filename).toBe('src/page.tsx');
  });

  it('resolves a node frame (bare path filename)', async () => {
    const release = newRelease('node');
    await uploadMap(release.id, 'node', 'dist/worker.js', buildMap('src/worker.ts'));
    const eventId = seedWebEvent(release.id, 'node', [
      { filename: '/srv/app/dist/worker.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.filename).toBe('src/worker.ts');
  });

  it('marks an unmatched frame no_symbols (maps exist, none cover it)', async () => {
    const release = newRelease('web');
    await uploadMap(release.id, 'web', 'static/chunks/main.js', buildMap('src/app.ts'));
    const eventId = seedWebEvent(release.id, 'web', [
      {
        filename: 'https://app.example.com/_next/static/chunks/other.js',
        function: 'z',
        lineno: 1,
        colno: 0,
        inApp: true,
      },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('no_symbols');
    expect(frames[0]?.function).toBe('z');
  });

  it('marks a frame no_symbols when the release has no maps uploaded', async () => {
    const release = newRelease('web');
    const eventId = seedWebEvent(release.id, 'web', [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('no_symbols');
  });

  it('marks a matched-but-corrupt map corrupt_sourcemap', async () => {
    const release = newRelease('web');
    await uploadMap(release.id, 'web', 'static/chunks/main.js', 'not valid json {{{');
    const eventId = seedWebEvent(release.id, 'web', [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('corrupt_sourcemap');
  });

  it('picks the longest-suffix bundle when several could match', async () => {
    const release = newRelease('node');
    // A short map that would also suffix-match, plus the specific longer one.
    await uploadMap(release.id, 'node', 'page.js', buildMap('src/WRONG.ts'));
    await uploadMap(release.id, 'node', 'server/app/page.js', buildMap('src/RIGHT.ts'));
    const eventId = seedWebEvent(release.id, 'node', [
      { filename: 'file:///srv/app/.next/server/app/page.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.filename).toBe('src/RIGHT.ts');
  });

  it('caches resolved frames (second call works after the map file is deleted)', async () => {
    const release = newRelease('web');
    await uploadMap(release.id, 'web', 'static/chunks/main.js', buildMap('src/cached.ts'));
    const eventId = seedWebEvent(release.id, 'web', [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const first = await symbolicateEvent(db, eventId);
    expect(first[0]?.status).toBe('ok');

    await fs.rm(path.join(tmpDir, release.id), { recursive: true, force: true });
    const second = await symbolicateEvent(db, eventId);
    expect(second[0]?.status).toBe('ok');
    expect(second[0]?.filename).toBe('src/cached.ts');
  });
});
