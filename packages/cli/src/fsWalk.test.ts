import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFilesRecursive } from './fsWalk.js';

describe('listFilesRecursive', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-fswalk-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array for a directory that does not exist', async () => {
    const result = await listFilesRecursive(path.join(tmpDir, 'nope'));
    expect(result).toEqual([]);
  });

  it('lists nested files with relative paths', async () => {
    await fs.mkdir(path.join(tmpDir, 'chunks', 'nested'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'top.js.map'), '{}');
    await fs.writeFile(path.join(tmpDir, 'chunks', 'a.js.map'), '{}');
    await fs.writeFile(path.join(tmpDir, 'chunks', 'nested', 'b.js.map'), '{}');
    await fs.writeFile(path.join(tmpDir, 'chunks', 'a.js'), 'console.log(1)');

    const result = await listFilesRecursive(tmpDir);
    const normalized = result.map((p) => p.split(path.sep).join('/')).sort();

    expect(normalized).toEqual(
      ['chunks/a.js', 'chunks/a.js.map', 'chunks/nested/b.js.map', 'top.js.map'].sort(),
    );
  });

  it('treats a path that is a file, not a directory, as empty rather than throwing', async () => {
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    await fs.writeFile(filePath, 'x');
    const result = await listFilesRecursive(filePath);
    expect(result).toEqual([]);
  });
});
