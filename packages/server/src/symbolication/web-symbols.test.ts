import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractPathComponent,
  isUnderDir,
  listWebSymbolMaps,
  matchBundlePath,
  sanitizeBundlePath,
  webSymbolMapPath,
} from './web-symbols.js';
import { platformSymbolsDir } from './storage.js';

describe('sanitizeBundlePath — security (traversal)', () => {
  it('accepts a normal nested relative path', () => {
    const r = sanitizeBundlePath('static/chunks/4bd1b696.js');
    expect(r).toEqual({ ok: true, path: 'static/chunks/4bd1b696.js' });
  });

  it('rejects a `..` traversal segment', () => {
    expect(sanitizeBundlePath('../../etc/passwd')).toEqual({ ok: false, reason: 'traversal' });
  });

  it('rejects a `..` buried mid-path', () => {
    expect(sanitizeBundlePath('static/../../secret')).toEqual({ ok: false, reason: 'traversal' });
  });

  it('rejects a POSIX absolute path', () => {
    expect(sanitizeBundlePath('/etc/passwd')).toEqual({ ok: false, reason: 'absolute' });
  });

  it('rejects a Windows drive-letter absolute path', () => {
    expect(sanitizeBundlePath('C:\\Windows\\system32').ok).toBe(false);
    expect(sanitizeBundlePath('C:/Windows/system32')).toEqual({ ok: false, reason: 'absolute' });
  });

  it('normalizes backslashes and still blocks backslash traversal', () => {
    // `..\..\x` normalizes to `../../x` → traversal.
    expect(sanitizeBundlePath('..\\..\\x')).toEqual({ ok: false, reason: 'traversal' });
    // A backslash-only nested path normalizes to forward slashes.
    expect(sanitizeBundlePath('static\\chunks\\a.js')).toEqual({
      ok: true,
      path: 'static/chunks/a.js',
    });
  });

  it('rejects an over-length path (> 512)', () => {
    expect(sanitizeBundlePath('a'.repeat(513))).toEqual({ ok: false, reason: 'too_long' });
    expect(sanitizeBundlePath('a'.repeat(512)).ok).toBe(true);
  });

  it('rejects empty / non-string input', () => {
    expect(sanitizeBundlePath('').ok).toBe(false);
    expect(sanitizeBundlePath(undefined).ok).toBe(false);
    expect(sanitizeBundlePath(null).ok).toBe(false);
    expect(sanitizeBundlePath(123).ok).toBe(false);
  });

  it('rejects control characters (NUL injection)', () => {
    const withNul = 'static/a' + String.fromCharCode(0) + '.js';
    expect(sanitizeBundlePath(withNul)).toEqual({ ok: false, reason: 'invalid_char' });
  });

  it('collapses `.`, `//` and leading/trailing slashes', () => {
    expect(sanitizeBundlePath('./static//chunks/a.js/')).toEqual({
      ok: true,
      path: 'static/chunks/a.js',
    });
  });

  it('the sanitized path always stays under the platform dir', () => {
    const platformDir = platformSymbolsDir('rel-1', 'web');
    for (const candidate of ['static/chunks/a.js', 'a/b/c/d/e.js', './x/./y.js']) {
      const r = sanitizeBundlePath(candidate);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const dest = webSymbolMapPath('rel-1', 'web', r.path);
      expect(isUnderDir(platformDir, dest)).toBe(true);
    }
  });
});

describe('extractPathComponent — three filename shapes', () => {
  it('full http(s) URL → pathname', () => {
    expect(extractPathComponent('https://app.example.com/_next/static/chunks/x.js')).toBe(
      '/_next/static/chunks/x.js',
    );
  });

  it('bare path → unchanged', () => {
    expect(extractPathComponent('/_next/static/chunks/x.js')).toBe('/_next/static/chunks/x.js');
  });

  it('file:// URL → pathname', () => {
    expect(extractPathComponent('file:///app/.next/server/app/page.js')).toBe(
      '/app/.next/server/app/page.js',
    );
  });
});

describe('matchBundlePath — longest suffix match', () => {
  const bundles = ['static/chunks/4bd1b696.js', '.next/server/app/page.js', 'static/chunks/x.js'];

  it('matches a browser chunk from a full URL', () => {
    expect(
      matchBundlePath('https://app.example.com/_next/static/chunks/4bd1b696.js', bundles),
    ).toBe('static/chunks/4bd1b696.js');
  });

  it('matches a node chunk from a file:// URL', () => {
    expect(matchBundlePath('file:///srv/app/.next/server/app/page.js', bundles)).toBe(
      '.next/server/app/page.js',
    );
  });

  it('matches a bare path', () => {
    expect(matchBundlePath('/_next/static/chunks/x.js', bundles)).toBe('static/chunks/x.js');
  });

  it('picks the LONGEST suffix when several match', () => {
    // Both `page.js` and `app/page.js` are suffixes; the longer one wins.
    const candidates = ['page.js', 'app/page.js', 'server/app/page.js'];
    expect(matchBundlePath('file:///srv/app/.next/server/app/page.js', candidates)).toBe(
      'server/app/page.js',
    );
  });

  it('requires a segment boundary (no partial-segment match)', () => {
    // `chunks/x.js` must not match `chunks/xx.js`.
    expect(matchBundlePath('https://h/static/chunks/xx.js', ['chunks/x.js'])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchBundlePath('node:internal/process/task_queues', bundles)).toBeNull();
  });
});

describe('listWebSymbolMaps', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-web-list-'));
    process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
  });
  afterEach(async () => {
    delete process.env['UH_OH_SYMBOLS_DIR'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists uploaded maps across platforms with size and reconstructed bundlePath', async () => {
    const write = async (platform: 'web' | 'node', bundlePath: string, content: string) => {
      const dest = webSymbolMapPath('rel-1', platform, bundlePath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content);
    };
    await write('web', 'static/chunks/a.js', '{"m":1}');
    await write('web', 'static/chunks/deep/b.js', '{"m":22}');
    await write('node', '.next/server/app/page.js', '{"m":333}');

    const maps = await listWebSymbolMaps('rel-1');
    expect(maps).toHaveLength(3);
    const web = maps.filter((m) => m.platform === 'web').map((m) => m.bundlePath);
    expect(web).toContain('static/chunks/a.js');
    expect(web).toContain('static/chunks/deep/b.js');
    const node = maps.find((m) => m.platform === 'node');
    expect(node?.bundlePath).toBe('.next/server/app/page.js');
    expect(node?.size).toBeGreaterThan(0);
  });

  it('returns an empty list when nothing uploaded', async () => {
    expect(await listWebSymbolMaps('nope')).toEqual([]);
  });
});
