import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease, markMappingUploaded } from '../db/repos/releases.js';
import { insertEvent } from '../db/repos/events.js';
import { upsertIssue } from '../db/repos/issues.js';
import { symbolicateEvent } from './symbolicate.js';

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
