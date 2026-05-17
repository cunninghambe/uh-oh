import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapGenerator } from 'source-map';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease, markMappingUploaded, markSourcemapUploaded } from '../db/repos/releases.js';
import { insertEvent } from '../db/repos/events.js';
import { upsertIssue } from '../db/repos/issues.js';
import { symbolicateEvent, invalidateSymbolications } from './symbolicate.js';
import { symbolications } from '../db/schema.js';

const MAPPING_TXT = `
com.example.MainActivity -> a.b:
    void onCreate(android.os.Bundle) -> c
    void crash() -> d

com.example.Utils -> e.f:
    java.lang.String helper() -> g
`;

let db: Db;
let close: () => void;
let tmpDir: string;

beforeEach(async () => {
  ({ db, close } = makeTestDb());
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-sym-test-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  close();
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makePayload = (frames: object[]) =>
  JSON.stringify({
    sdk: { name: '@uh-oh/react-native', version: '0.0.1' },
    timestamp: '2026-01-01T00:00:00.000Z',
    platform: 'android',
    release: { version: '1.0.0', build: '1' },
    level: 'error',
    exception: {
      type: 'RuntimeException',
      value: 'crash',
      stacktrace: frames,
      mechanism: 'android-java-ueh',
    },
    breadcrumbs: [],
    device: { osName: 'Android', osVersion: '14' },
  });

const seedEvent = (db: Db, releaseId: string | null, frames: object[]) => {
  const project = createProject(db, { name: 'App' });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: 'fp1',
    title: 'crash',
    ts: Date.now(),
  });
  return insertEvent(db, {
    projectId: project.id,
    issueId: issue.id,
    releaseId,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'android',
    payload: makePayload(frames),
    receivedAt: Date.now(),
    deviceInfo: '{}',
    userInfo: null,
  });
};

describe('symbolicateEvent — no mapping', () => {
  it('returns no_symbols for Android frames when no mapping uploaded', async () => {
    const project = createProject(db, { name: 'App2' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const event = seedEvent(db, release.id, [{ module: 'a.b', function: 'c', inApp: true }]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('no_symbols');
  });

  it('returns empty array for unknown event id', async () => {
    const frames = await symbolicateEvent(db, 'no-such-event');
    expect(frames).toHaveLength(0);
  });
});

describe('symbolicateEvent — with mapping', () => {
  const setupMapping = async (releaseId: string) => {
    const dir = path.join(tmpDir, releaseId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mapping.txt'), MAPPING_TXT);
    markMappingUploaded(db, releaseId, Date.now());
  };

  it('deobfuscates Android class and method names', async () => {
    const project = createProject(db, { name: 'App3' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    await setupMapping(release.id);
    const event = seedEvent(db, release.id, [{ module: 'a.b', function: 'c', inApp: true }]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.module).toBe('com.example.MainActivity');
    expect(frames[0]?.function).toBe('onCreate');
  });

  it('returns ok with raw module when class not in mapping', async () => {
    const project = createProject(db, { name: 'App4' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    await setupMapping(release.id);
    const event = seedEvent(db, release.id, [
      { module: 'x.y.Unknown', function: 'z', inApp: true },
    ]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.module).toBe('x.y.Unknown');
  });

  it('cache hit short-circuits parse on second call', async () => {
    const project = createProject(db, { name: 'App5' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    await setupMapping(release.id);
    const event = seedEvent(db, release.id, [{ module: 'a.b', function: 'c', inApp: true }]);
    const first = await symbolicateEvent(db, event.id);
    // Delete the mapping file to prove cache is used on second call
    await fs.rm(path.join(tmpDir, release.id), { recursive: true });
    const second = await symbolicateEvent(db, event.id);
    expect(second[0]?.module).toBe(first[0]?.module);
    expect(second[0]?.status).toBe('ok');
  });

  it('corrupt mapping file returns corrupt_mapping status', async () => {
    const project = createProject(db, { name: 'App6' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    // Mark as uploaded but don't write a file (simulate corrupt/missing file after record set)
    markMappingUploaded(db, release.id, Date.now());
    const event = seedEvent(db, release.id, [{ module: 'a.b', function: 'c', inApp: true }]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('corrupt_mapping');
  });
});

describe('symbolicateEvent — JS frames', () => {
  it('returns ok status for JS frames (left raw, pending 7c)', async () => {
    const event = seedEvent(db, null, [
      { module: 'src/App.tsx', function: 'render', filename: 'src/App.tsx', inApp: true },
    ]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.module).toBe('src/App.tsx');
  });
});

const buildSourceMap = (
  mapping: {
    genLine: number;
    genCol: number;
    source: string;
    origLine: number;
    origCol: number;
    name?: string;
  }[],
): string => {
  const gen = new SourceMapGenerator({ file: 'index.android.bundle' });
  for (const m of mapping) {
    gen.addMapping({
      generated: { line: m.genLine, column: m.genCol },
      original: { line: m.origLine, column: m.origCol },
      source: m.source,
      ...(m.name !== undefined ? { name: m.name } : {}),
    });
  }
  return gen.toString();
};

const seedEventForRelease = (db: Db, releaseId: string, frames: object[]) => {
  const project = createProject(db, { name: 'JsApp' });
  const { issue } = upsertIssue(db, {
    projectId: project.id,
    fingerprint: `fp-${Math.random()}`,
    title: 'js crash',
    ts: Date.now(),
  });
  return insertEvent(db, {
    projectId: project.id,
    issueId: issue.id,
    releaseId,
    fingerprint: 'fp1',
    level: 'error',
    platform: 'android',
    payload: makePayload(frames),
    receivedAt: Date.now(),
    deviceInfo: '{}',
    userInfo: null,
  });
};

describe('symbolicateEvent — JS frames with sourcemap', () => {
  const setupSourcemap = async (releaseId: string, raw: string) => {
    const dir = path.join(tmpDir, releaseId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'sourcemap.map'), raw);
    markSourcemapUploaded(db, releaseId, Date.now());
  };

  it('resolves JS frame to original source when sourcemap uploaded', async () => {
    const project = createProject(db, { name: 'JsApp2' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'src/greet.ts', origLine: 3, origCol: 0, name: 'greet' },
    ]);
    await setupSourcemap(release.id, raw);
    const event = seedEventForRelease(db, release.id, [
      { filename: 'index.android.bundle', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.filename).toBe('src/greet.ts');
    expect(frames[0]?.lineno).toBe(3);
  });

  it('returns no_symbols for JS frame when release exists but no sourcemap uploaded', async () => {
    const project = createProject(db, { name: 'JsApp3' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const event = seedEventForRelease(db, release.id, [
      { filename: 'index.android.bundle', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('no_symbols');
  });

  it('symbolicates mixed Java + JS frames correctly', async () => {
    const project = createProject(db, { name: 'MixedApp' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'App.ts', origLine: 10, origCol: 0 },
    ]);
    await setupSourcemap(release.id, raw);

    const mappingTxt = `
com.example.MainActivity -> a.b:
    void onCreate(android.os.Bundle) -> c
`;
    const dir = path.join(tmpDir, release.id);
    await fs.writeFile(path.join(dir, 'mapping.txt'), mappingTxt);
    markMappingUploaded(db, release.id, Date.now());

    const event = seedEventForRelease(db, release.id, [
      { module: 'a.b', function: 'c', inApp: true },
      { filename: 'index.android.bundle', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, event.id);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.module).toBe('com.example.MainActivity');
    expect(frames[1]?.status).toBe('ok');
    expect(frames[1]?.filename).toBe('App.ts');
  });

  it('cached symbolications survive re-call and invalidation clears cache', async () => {
    const project = createProject(db, { name: 'CacheApp' });
    const release = upsertRelease(db, {
      projectId: project.id,
      version: '1.0.0',
      build: '1',
      platform: 'android',
    });
    const raw = buildSourceMap([
      { genLine: 1, genCol: 0, source: 'cached.ts', origLine: 5, origCol: 0 },
    ]);
    await setupSourcemap(release.id, raw);
    const event = seedEventForRelease(db, release.id, [
      { filename: 'index.android.bundle', lineno: 1, colno: 0, inApp: true },
    ]);

    const first = await symbolicateEvent(db, event.id);
    expect(first[0]?.status).toBe('ok');

    // Remove the sourcemap file — second call should still hit DB cache
    await fs.rm(path.join(tmpDir, release.id, 'sourcemap.map'));
    const second = await symbolicateEvent(db, event.id);
    expect(second[0]?.status).toBe('ok');
    expect(second[0]?.filename).toBe(first[0]?.filename);

    // Invalidate clears the DB cache rows
    invalidateSymbolications(db, release.id);
    const countAfter = db.select().from(symbolications).all().length;
    expect(countAfter).toBe(0);
  });
});
