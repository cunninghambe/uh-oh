import { spawn } from 'node:child_process';

// Mirrors the server's releases.commit_sha column constraint (SPEC 23):
// 7-40 hex chars, case-insensitive; stored (and sent) lowercase.
export const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

export type GitRevParseHead = (cwd: string) => Promise<string | undefined>;

// Guarded `git rev-parse HEAD` run in `cwd`. ANY failure - git missing from
// PATH, cwd not inside a repo, a non-zero exit - resolves to undefined rather
// than rejecting; resolveCommitSha treats that identically to "nothing to
// resolve" and is the one that logs, so this stays silent either way.
export const gitRevParseHead: GitRevParseHead = (cwd) =>
  new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolvePromise(undefined);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.on('error', () => resolvePromise(undefined));
    child.on('close', (code) => {
      resolvePromise(code === 0 ? out.trim() : undefined);
    });
  });

export type ResolveCommitShaDeps = {
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  gitRevParseHead?: GitRevParseHead;
};

// Resolves the commitSha sent with a release upsert (SPEC 23 "Release <->
// commit"), in priority order: the --commit flag, the UH_OH_COMMIT_SHA env
// var, then a guarded `git rev-parse HEAD` in `cwd`. Whichever source answers
// first is the one that's validated - it does NOT fall through to a
// lower-priority source just because the higher-priority one was invalid.
// Anything that isn't a usable, valid SHA (nothing resolved, git failed, or
// the resolved value fails COMMIT_SHA_RE) omits commitSha and writes exactly
// one informational log line; a successful resolution is silent and the
// returned value is always lowercased.
export const resolveCommitSha = async (
  flagValue: string | undefined,
  deps: ResolveCommitShaDeps,
): Promise<string | undefined> => {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const lookupGit = deps.gitRevParseHead ?? gitRevParseHead;

  const envValue = env['UH_OH_COMMIT_SHA'];
  let candidate: string | undefined;
  let source: 'flag' | 'env' | 'git';
  if (flagValue) {
    candidate = flagValue;
    source = 'flag';
  } else if (envValue) {
    candidate = envValue;
    source = 'env';
  } else {
    candidate = await lookupGit(cwd);
    source = 'git';
  }

  if (candidate && COMMIT_SHA_RE.test(candidate)) {
    return candidate.toLowerCase();
  }

  if (source === 'git') {
    deps.log(
      'Could not resolve a commit SHA (no --commit, no UH_OH_COMMIT_SHA, and `git rev-parse HEAD` failed) - omitting commitSha',
    );
  } else {
    const label = source === 'flag' ? '--commit' : 'UH_OH_COMMIT_SHA';
    deps.log(`Ignoring invalid commit SHA "${candidate}" from ${label} - omitting commitSha`);
  }
  return undefined;
};
