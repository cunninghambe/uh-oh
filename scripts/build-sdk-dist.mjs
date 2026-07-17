#!/usr/bin/env node
// Builds @uh-oh/react-native as a self-contained, npm-installable package and
// force-pushes it to the `sdk-dist` branch on origin. Consumers (Tideline,
// future RN apps) install via `pnpm add github:cunninghambe/uh-oh#sdk-dist`.
//
// Why a separate branch: main is a pnpm monorepo. `@uh-oh/react-native` is
// marked `private: true` and depends on `@uh-oh/types: workspace:*`, neither
// of which work outside the workspace. This script inlines @uh-oh/types,
// strips the private flag, drops a flat package.json, and ships only what
// a consuming RN app needs.
//
// Run from the uh-oh repo root:
//   node scripts/build-sdk-dist.mjs
//
// Requirements: pnpm, git, write access to origin.
// Works on both Windows (dev machine) and Linux/macOS: uses os.tmpdir()
// instead of a hardcoded /tmp path, and path.join/path.relative throughout
// so path comparisons are correct under either separator convention.

/* global console, process */

import { execSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const STAGE = join(os.tmpdir(), 'uh-oh-sdk-dist-stage');
const TMP_REPO = join(os.tmpdir(), 'uh-oh-sdk-dist-repo');
const BRANCH = 'sdk-dist';
const TYPES_DIR_NAME = '_uh_oh_types';

// ── Copy filter for packages/sdk/android — exported so it's unit-testable
// (see build-sdk-dist.test.mjs, run via `node --test scripts/`) without
// having to run the whole publish flow. Excludes Gradle build output
// directories (top-level `build/`, and nested ones like `app/build/`)
// while keeping source files that merely start with "build" in their name,
// e.g. `build.gradle` itself — the previous
// `!rel.startsWith('build')` check excluded that file too, which meant the
// published sdk-dist branch shipped without its own build.gradle and could
// not compile in a consumer app.
//
// Splits on both `/` and `\` so relative paths compare correctly regardless
// of whether they were produced by path.relative() on POSIX or Windows.
/**
 * @param {string} relPath
 * @returns {boolean}
 */
export function isGradleBuildOutputPath(relPath) {
  if (!relPath) return false;
  return relPath.split(/[\\/]+/).includes('build');
}

/**
 * @param {string} cmd
 * @param {{ cwd?: string }} [opts]
 */
function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

/**
 * @param {string} cmd
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
function runQuiet(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

/**
 * @param {string} dir
 * @param {string} typesDest
 */
function walkAndRewrite(dir, typesDest) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkAndRewrite(p, typesDest);
      continue;
    }
    if (!/\.(d\.ts|d\.ts\.map|js|js\.map)$/.test(name)) continue;
    const content = readFileSync(p, 'utf8');
    if (!content.includes('@uh-oh/types')) continue;
    let rel = relative(dirname(p), typesDest).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    const updated = content
      .replaceAll("'@uh-oh/types'", `'${rel}'`)
      .replaceAll('"@uh-oh/types"', `"${rel}"`);
    writeFileSync(p, updated);
  }
}

// Everything below is the actual publish flow (rebuild, stage, force-push to
// the sdk-dist branch). It's wrapped in a function — rather than left as
// top-level side effects — so that importing this module for
// isGradleBuildOutputPath() (see build-sdk-dist.test.mjs) does not also
// rebuild the SDK and force-push to origin. Only runs when this file is
// executed directly, e.g. `node scripts/build-sdk-dist.mjs` (see the guard
// at the bottom of the file).
function publish() {
  // ── 1. Verify clean state and rebuild ────────────────────────────────────
  const status = runQuiet('git status --porcelain', { cwd: REPO });
  if (status) {
    console.error('ERROR: working tree is dirty. Commit or stash before publishing.');
    console.error(status);
    process.exit(1);
  }

  run('pnpm --filter @uh-oh/types build', { cwd: REPO });
  run('pnpm --filter @uh-oh/react-native build', { cwd: REPO });

  // ── 2. Stage ──────────────────────────────────────────────────────────────
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  // ── 3. Copy SDK dist ──────────────────────────────────────────────────────
  cpSync(join(REPO, 'packages/sdk/dist'), join(STAGE, 'dist'), { recursive: true });

  // ── 4. Copy types dist into a known subdir of SDK dist ───────────────────
  const typesDest = join(STAGE, 'dist', TYPES_DIR_NAME);
  cpSync(join(REPO, 'packages/types/dist'), typesDest, { recursive: true });

  // ── 5. Rewrite '@uh-oh/types' refs in .d.ts and .js files to relative paths
  walkAndRewrite(join(STAGE, 'dist'), typesDest);

  // ── 6. Copy android source (drop build artifacts) ────────────────────────
  const androidSrc = join(REPO, 'packages/sdk/android');
  const androidDst = join(STAGE, 'android');
  cpSync(androidSrc, androidDst, {
    recursive: true,
    filter: (src) => !isGradleBuildOutputPath(relative(androidSrc, src)),
  });

  // ── 7. Flattened package.json ─────────────────────────────────────────────
  // JSON.parse has no way to be statically typed without a runtime
  // validator (zod, etc.), which would be overkill for a one-off internal
  // build script reading its own repo's package.json. Scoped disable
  // rather than fighting the type system with JSDoc casts that checked-JS
  // mode doesn't reliably honor here.
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  const orig = JSON.parse(readFileSync(join(REPO, 'packages/sdk/package.json'), 'utf8'));
  const flat = {
    name: orig.name,
    version: orig.version,
    description: 'Lightweight self-hosted crash reporting SDK for React Native Android.',
    type: orig.type,
    main: orig.main,
    types: orig.types,
    exports: orig.exports,
    files: ['dist', 'android', 'react-native.config.js', 'README.md'],
    peerDependencies: {
      ...orig.peerDependencies,
      zod: '>=3.22.0',
    },
    repository: {
      type: 'git',
      url: 'https://github.com/cunninghambe/uh-oh',
      directory: 'packages/sdk',
    },
    license: 'UNLICENSED',
    private: false,
  };
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
  writeFileSync(join(STAGE, 'package.json'), JSON.stringify(flat, null, 2) + '\n');

  // ── 8. react-native autolinking config ────────────────────────────────────
  writeFileSync(
    join(STAGE, 'react-native.config.js'),
    `module.exports = {
  dependency: {
    platforms: {
      android: { sourceDir: './android' },
      ios: null,
    },
  },
};
`,
  );

  // ── 9. README pointer ─────────────────────────────────────────────────────
  const headSha = runQuiet('git rev-parse HEAD', { cwd: REPO });
  writeFileSync(
    join(STAGE, 'README.md'),
    `# @uh-oh/react-native

Auto-published from the \`main\` branch of https://github.com/cunninghambe/uh-oh via \`scripts/build-sdk-dist.mjs\`.

**Do not edit this branch by hand.** Run the script from \`main\` and force-push.

Built from \`main@${headSha.slice(0, 7)}\`.
`,
  );

  // ── 10. Push to sdk-dist orphan branch ────────────────────────────────────
  // TMP_REPO is quoted in every shell invocation below — os.tmpdir() can
  // contain spaces (e.g. a Windows username with a space in it), which would
  // otherwise split the path into multiple argv entries.
  rmSync(TMP_REPO, { recursive: true, force: true });
  const origin = runQuiet('git remote get-url origin', { cwd: REPO });
  run(`git clone ${origin} "${TMP_REPO}"`);
  run(`git -C "${TMP_REPO}" checkout --orphan ${BRANCH}`);
  run(`git -C "${TMP_REPO}" rm -rf .`);
  for (const name of readdirSync(STAGE)) {
    cpSync(join(STAGE, name), join(TMP_REPO, name), { recursive: true });
  }
  run(`git -C "${TMP_REPO}" add -A`);
  run(`git -C "${TMP_REPO}" commit -m "build: SDK dist from main@${headSha.slice(0, 7)}"`);
  run(`git -C "${TMP_REPO}" push --force origin ${BRANCH}`);

  console.log(
    `\n✅ Published @uh-oh/react-native to ${BRANCH} branch (source commit ${headSha.slice(0, 7)})`,
  );
  console.log(`Consumers install via: pnpm add github:cunninghambe/uh-oh#${BRANCH}`);
}

// Only run the publish flow when this file is the process entry point, not
// when it's imported (e.g. by build-sdk-dist.test.mjs for
// isGradleBuildOutputPath). Resolves argv[1] because Node doesn't normalize
// it to an absolute path when the script is invoked with a relative path.
const isEntryPoint =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  publish();
}
