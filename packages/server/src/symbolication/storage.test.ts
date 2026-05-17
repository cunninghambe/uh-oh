import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { symbolsDir, mappingPath, sourcemapPath, ensureSymbolsDir } from './storage.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-storage-test-'));
  process.env['UH_OH_SYMBOLS_DIR'] = tmpDir;
});

afterEach(async () => {
  delete process.env['UH_OH_SYMBOLS_DIR'];
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('storage paths', () => {
  it('symbolsDir returns path containing releaseId under SYMBOLS_ROOT', () => {
    expect(symbolsDir('abc')).toContain('abc');
    expect(symbolsDir('abc')).toContain(tmpDir);
  });

  it('mappingPath returns mapping.txt inside release dir', () => {
    expect(mappingPath('r1')).toMatch(/mapping\.txt$/);
    expect(mappingPath('r1')).toContain('r1');
    expect(mappingPath('r1')).toContain(tmpDir);
  });

  it('sourcemapPath returns sourcemap.map inside release dir', () => {
    expect(sourcemapPath('r1')).toMatch(/sourcemap\.map$/);
    expect(sourcemapPath('r1')).toContain('r1');
    expect(sourcemapPath('r1')).toContain(tmpDir);
  });

  it('ensureSymbolsDir creates directory', async () => {
    const releaseId = 'test-release-123';
    await ensureSymbolsDir(releaseId);
    const stat = await fs.stat(symbolsDir(releaseId));
    expect(stat.isDirectory()).toBe(true);
  });

  it('ensureSymbolsDir is idempotent', async () => {
    await ensureSymbolsDir('r2');
    await expect(ensureSymbolsDir('r2')).resolves.toBeUndefined();
  });
});
