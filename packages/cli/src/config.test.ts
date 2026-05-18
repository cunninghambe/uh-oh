import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// We test the real config logic using a temp directory
import { readConfig, writeConfig } from './config.js';

// Override HOME to isolate tests
const originalHome = os.homedir;

describe('config', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-test-'));
    // Patch homedir to return tmpDir
    (os as { homedir: typeof os.homedir }).homedir = () => tmpDir;
  });

  afterEach(async () => {
    (os as { homedir: typeof os.homedir }).homedir = originalHome;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when config file does not exist', async () => {
    const result = await readConfig();
    expect(result).toBeNull();
  });

  it('round-trips config with server only', async () => {
    await writeConfig({ server: 'http://localhost:3300' });
    const result = await readConfig();
    expect(result).toEqual({ server: 'http://localhost:3300' });
  });

  it('round-trips config with server and token', async () => {
    await writeConfig({ server: 'https://errors.example.com', token: 'tok_abc123' });
    const result = await readConfig();
    expect(result).toEqual({ server: 'https://errors.example.com', token: 'tok_abc123' });
  });

  it('creates parent directories if they do not exist', async () => {
    await writeConfig({ server: 'http://localhost:3300' });
    const cfgDir = path.join(tmpDir, '.config', 'uh-oh');
    const stat = await fs.stat(cfgDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
