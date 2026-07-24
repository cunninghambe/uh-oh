import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { COMMIT_SHA_RE, gitRevParseHead, resolveCommitSha } from './commitSha.js';
import type { GitRevParseHead } from './commitSha.js';

const makeGit = (result: string | undefined): { fn: GitRevParseHead; calls: string[] } => {
  const calls: string[] = [];
  return {
    fn: (cwd) => {
      calls.push(cwd);
      return Promise.resolve(result);
    },
    calls,
  };
};

describe('COMMIT_SHA_RE', () => {
  it('accepts 7 to 40 lowercase or uppercase hex chars', () => {
    expect(COMMIT_SHA_RE.test('a1b2c3d')).toBe(true); // 7
    expect(COMMIT_SHA_RE.test('A1B2C3D')).toBe(true); // uppercase
    expect(COMMIT_SHA_RE.test('a'.repeat(40))).toBe(true); // 40
  });

  it('rejects too-short, too-long, and non-hex values', () => {
    expect(COMMIT_SHA_RE.test('a1b2c3')).toBe(false); // 6 chars
    expect(COMMIT_SHA_RE.test('a'.repeat(41))).toBe(false); // 41 chars
    expect(COMMIT_SHA_RE.test('g1b2c3d')).toBe(false); // 'g' is not hex
    expect(COMMIT_SHA_RE.test('')).toBe(false);
  });
});

describe('resolveCommitSha', () => {
  it('prefers the --commit flag over env and git, and lowercases it', async () => {
    const logs: string[] = [];
    const git = makeGit('1111111');
    const result = await resolveCommitSha('ABCDEF1', {
      log: (l) => logs.push(l),
      env: { UH_OH_COMMIT_SHA: '2222222' },
      gitRevParseHead: git.fn,
    });
    expect(result).toBe('abcdef1');
    expect(git.calls).toHaveLength(0); // git never invoked once the flag answers
    expect(logs).toHaveLength(0);
  });

  it('falls back to UH_OH_COMMIT_SHA when no flag is given, and lowercases it', async () => {
    const logs: string[] = [];
    const git = makeGit('1111111');
    const result = await resolveCommitSha(undefined, {
      log: (l) => logs.push(l),
      env: { UH_OH_COMMIT_SHA: 'ABCDEF1' },
      gitRevParseHead: git.fn,
    });
    expect(result).toBe('abcdef1');
    expect(git.calls).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('treats an empty --commit flag as not given and falls through to env', async () => {
    const result = await resolveCommitSha('', {
      log: () => {},
      env: { UH_OH_COMMIT_SHA: 'abcdef1' },
    });
    expect(result).toBe('abcdef1');
  });

  it('falls back to guarded `git rev-parse HEAD` when neither flag nor env is set, using the given cwd', async () => {
    const logs: string[] = [];
    const git = makeGit('3333333');
    const result = await resolveCommitSha(undefined, {
      log: (l) => logs.push(l),
      env: {},
      cwd: '/some/project/dir',
      gitRevParseHead: git.fn,
    });
    expect(result).toBe('3333333');
    expect(git.calls).toEqual(['/some/project/dir']);
    expect(logs).toHaveLength(0);
  });

  it('an invalid --commit flag is unresolvable: omit + exactly one log line, git never runs', async () => {
    const logs: string[] = [];
    const git = makeGit('1111111');
    const result = await resolveCommitSha('not-a-sha', {
      log: (l) => logs.push(l),
      env: { UH_OH_COMMIT_SHA: 'abcdef1' },
      gitRevParseHead: git.fn,
    });
    expect(result).toBeUndefined();
    expect(git.calls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/--commit/);
  });

  it('an invalid UH_OH_COMMIT_SHA is unresolvable: omit + exactly one log line, git never runs', async () => {
    const logs: string[] = [];
    const git = makeGit('1111111');
    const result = await resolveCommitSha(undefined, {
      log: (l) => logs.push(l),
      env: { UH_OH_COMMIT_SHA: 'zzz' },
      gitRevParseHead: git.fn,
    });
    expect(result).toBeUndefined();
    expect(git.calls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/UH_OH_COMMIT_SHA/);
  });

  it('a failed `git rev-parse HEAD` (no git, not a repo, non-zero exit) is silently omitted with one log line', async () => {
    const logs: string[] = [];
    const git = makeGit(undefined);
    const result = await resolveCommitSha(undefined, {
      log: (l) => logs.push(l),
      env: {},
      gitRevParseHead: git.fn,
    });
    expect(result).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/git rev-parse HEAD/);
  });

  it('a `git rev-parse HEAD` result that fails validation is also omitted with one log line', async () => {
    const logs: string[] = [];
    const git = makeGit('not-hex-output');
    const result = await resolveCommitSha(undefined, {
      log: (l) => logs.push(l),
      env: {},
      gitRevParseHead: git.fn,
    });
    expect(result).toBeUndefined();
    expect(logs).toHaveLength(1);
  });

  it('defaults cwd to process.cwd() and env to process.env when not provided', async () => {
    const git = makeGit('4444444');
    const result = await resolveCommitSha(undefined, { log: () => {}, gitRevParseHead: git.fn });
    expect(result).toBe('4444444');
    expect(git.calls).toEqual([process.cwd()]);
  });
});

describe('gitRevParseHead (real child_process spawn)', () => {
  it('resolves the current HEAD sha inside this git repository', async () => {
    // The uh-oh repo itself is the fixture - no need to construct one.
    const sha = await gitRevParseHead(process.cwd());
    expect(sha).toBeDefined();
    expect(COMMIT_SHA_RE.test(sha ?? '')).toBe(true);
  });

  it('resolves undefined in a directory that is not a git repository', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uh-oh-commit-sha-'));
    try {
      const sha = await gitRevParseHead(dir);
      expect(sha).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
