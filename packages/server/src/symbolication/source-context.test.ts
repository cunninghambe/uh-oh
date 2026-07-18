import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map';

import type { Db } from '../db/index.js';
import { makeTestDb } from '../db/test-utils.js';
import { createProject } from '../db/repos/projects.js';
import { upsertRelease, markSourcemapUploaded } from '../db/repos/releases.js';
import { insertEvent } from '../db/repos/events.js';
import { upsertIssue } from '../db/repos/issues.js';
import { symbolicateEvent } from './symbolicate.js';
import { webSymbolMapPath } from './web-symbols.js';
import { CONTEXT_LINES, MAX_LINE_LEN, extractContext } from './source-context.js';

// ── extractContext unit tests ─────────────────────────────────────────────────

const buildContentMap = (source: string, content: string, origLine: number): string => {
  const gen = new SourceMapGenerator({ file: 'bundle.js' });
  gen.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: origLine, column: 0 },
    source,
  });
  gen.setSourceContent(source, content);
  return gen.toString();
};

describe('extractContext', () => {
  const SRC = 'src/app.ts';
  // 50 numbered lines, plus a couple of special ones we assert on.
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  lines[9] = '\tindented\twith\ttabs'; // line 10 (leading + interior tabs)
  lines[10] = 'trailing spaces   \t '; // line 11 (should be right-trimmed)
  lines[11] = 'x'.repeat(400); // line 12 (should be capped at 300)
  const CONTENT = lines.join('\n');

  it('returns pre/line/post windows around the crash line', async () => {
    const consumer = await new SourceMapConsumer(buildContentMap(SRC, CONTENT, 20));
    try {
      const ctx = extractContext(consumer, SRC, 20);
      expect(ctx).not.toBeNull();
      expect(ctx?.line).toBe('line 20');
      expect(ctx?.pre).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19']);
      expect(ctx?.post).toEqual(['line 21', 'line 22', 'line 23', 'line 24', 'line 25']);
      expect(ctx?.pre).toHaveLength(CONTEXT_LINES);
      expect(ctx?.post).toHaveLength(CONTEXT_LINES);
    } finally {
      consumer.destroy();
    }
  });

  it('clamps pre/post at file edges', async () => {
    const consumer = await new SourceMapConsumer(buildContentMap(SRC, CONTENT, 2));
    try {
      const ctx = extractContext(consumer, SRC, 2);
      expect(ctx?.pre).toEqual(['line 1']); // only one line before line 2
      expect(ctx?.line).toBe('line 2');
    } finally {
      consumer.destroy();
    }
  });

  it('preserves tabs, right-trims trailing whitespace, and caps at 300 chars', async () => {
    const consumer = await new SourceMapConsumer(buildContentMap(SRC, CONTENT, 11));
    try {
      const ctx = extractContext(consumer, SRC, 11);
      // Line 11 itself (trailing whitespace stripped).
      expect(ctx?.line).toBe('trailing spaces');
      // Line 10 sits in pre and keeps its tabs.
      expect(ctx?.pre.at(-1)).toBe('\tindented\twith\ttabs');
      // Line 12 sits in post and is capped at MAX_LINE_LEN.
      expect(ctx?.post[0]).toBe('x'.repeat(MAX_LINE_LEN));
    } finally {
      consumer.destroy();
    }
  });

  it('returns null for an out-of-range line', async () => {
    const consumer = await new SourceMapConsumer(buildContentMap(SRC, CONTENT, 5));
    try {
      expect(extractContext(consumer, SRC, 9999)).toBeNull();
      expect(extractContext(consumer, SRC, 0)).toBeNull();
    } finally {
      consumer.destroy();
    }
  });

  it('returns null when the map carries no embedded content for the source', async () => {
    const gen = new SourceMapGenerator({ file: 'bundle.js' });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 3, column: 0 },
      source: SRC,
    });
    const consumer = await new SourceMapConsumer(gen.toString());
    try {
      expect(extractContext(consumer, SRC, 3)).toBeNull();
    } finally {
      consumer.destroy();
    }
  });
});

// ── symbolicateEvent integration ──────────────────────────────────────────────

describe('symbolicateEvent — source context (CONTRACT S)', () => {
  let db: Db;
  let close: () => void;
  let tmpDir: string;

  beforeEach(async () => {
    ({ db, close } = makeTestDb());
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-ctx-'));
    process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
  });

  afterEach(async () => {
    close();
    delete process.env['UH_OH_SYMBOLS_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const CONTENT = Array.from({ length: 60 }, (_, i) => `code line ${i + 1}`).join('\n');

  const mapWithContent = (source: string): string => buildContentMap(source, CONTENT, 42);
  const mapNoContent = (source: string): string => {
    const gen = new SourceMapGenerator({ file: 'bundle.js' });
    gen.addMapping({
      generated: { line: 1, column: 0 },
      original: { line: 42, column: 0 },
      source,
    });
    return gen.toString();
  };

  const uploadMap = async (releaseId: string, bundlePath: string, raw: string): Promise<void> => {
    const dest = webSymbolMapPath(releaseId, 'web', bundlePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, raw);
    markSourcemapUploaded(db, releaseId, Date.now());
  };

  const seed = (releaseId: string, frames: object[]): string => {
    const project = createProject(db, { name: `p-${Math.random()}` });
    const { issue } = upsertIssue(db, {
      projectId: project.id,
      fingerprint: `fp-${Math.random()}`,
      title: 't',
      ts: Date.now(),
    });
    const payload = JSON.stringify({
      sdk: { name: '@uh-oh/js', version: '0.2.0' },
      timestamp: '2026-01-01T00:00:00.000Z',
      platform: 'web',
      release: { version: '2.0.0', build: '9' },
      level: 'error',
      exception: { type: 'Error', value: 'boom', stacktrace: frames, mechanism: 'js-global' },
      breadcrumbs: [],
      device: { osName: 'linux', osVersion: '1' },
    });
    return insertEvent(db, {
      projectId: project.id,
      issueId: issue.id,
      releaseId,
      fingerprint: 'fp',
      level: 'error',
      platform: 'web',
      payload,
      receivedAt: Date.now(),
      deviceInfo: '{}',
      userInfo: null,
    }).id;
  };

  const newRelease = () => {
    const project = createProject(db, { name: `rel-${Math.random()}` });
    return upsertRelease(db, {
      projectId: project.id,
      version: '2.0.0',
      build: '9',
      platform: 'web',
    });
  };

  it('attaches source context to an in-app frame when the map embeds content', async () => {
    const release = newRelease();
    await uploadMap(release.id, 'static/chunks/main.js', mapWithContent('src/app.ts'));
    const eventId = seed(release.id, [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.context).toBeDefined();
    expect(frames[0]?.context?.line).toBe('code line 42');
    expect(frames[0]?.context?.pre).toEqual([
      'code line 37',
      'code line 38',
      'code line 39',
      'code line 40',
      'code line 41',
    ]);
    expect(frames[0]?.context?.post[0]).toBe('code line 43');
  });

  it('omits context when the map has no embedded source content', async () => {
    const release = newRelease();
    await uploadMap(release.id, 'static/chunks/main.js', mapNoContent('src/app.ts'));
    const eventId = seed(release.id, [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.context).toBeUndefined();
  });

  it('never attaches context to non-in-app frames', async () => {
    const release = newRelease();
    await uploadMap(release.id, 'static/chunks/main.js', mapWithContent('src/app.ts'));
    const eventId = seed(release.id, [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: false },
    ]);
    const frames = await symbolicateEvent(db, eventId);
    expect(frames[0]?.status).toBe('ok');
    expect(frames[0]?.context).toBeUndefined();
  });

  it('caps context to the first 8 in-app frames', async () => {
    const release = newRelease();
    await uploadMap(release.id, 'static/chunks/main.js', mapWithContent('src/app.ts'));
    const frames = Array.from({ length: 10 }, () => ({
      filename: 'https://h/static/chunks/main.js',
      lineno: 1,
      colno: 0,
      inApp: true,
    }));
    const eventId = seed(release.id, frames);
    const resolved = await symbolicateEvent(db, eventId);
    const withContext = resolved.filter((f) => f.context !== undefined);
    expect(withContext).toHaveLength(8);
    // The first 8 have it; the 9th and 10th do not.
    expect(resolved[7]?.context).toBeDefined();
    expect(resolved[8]?.context).toBeUndefined();
    expect(resolved[9]?.context).toBeUndefined();
  });

  it('persists context through the symbolication cache', async () => {
    const release = newRelease();
    await uploadMap(release.id, 'static/chunks/main.js', mapWithContent('src/app.ts'));
    const eventId = seed(release.id, [
      { filename: 'https://h/static/chunks/main.js', lineno: 1, colno: 0, inApp: true },
    ]);
    await symbolicateEvent(db, eventId);
    // Remove the map on disk; the cached row must still carry context.
    await fs.rm(path.join(tmpDir, release.id), { recursive: true, force: true });
    const second = await symbolicateEvent(db, eventId);
    expect(second[0]?.context?.line).toBe('code line 42');
  });
});
