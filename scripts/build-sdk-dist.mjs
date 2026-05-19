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

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const STAGE = '/tmp/uh-oh-sdk-dist-stage';
const TMP_REPO = '/tmp/uh-oh-sdk-dist-repo';
const BRANCH = 'sdk-dist';
const TYPES_DIR_NAME = '_uh_oh_types';

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
}

function runQuiet(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
}

// ── 1. Verify clean state and rebuild ──────────────────────────────────────
const status = runQuiet('git status --porcelain', { cwd: REPO });
if (status) {
  console.error('ERROR: working tree is dirty. Commit or stash before publishing.');
  console.error(status);
  process.exit(1);
}

run('pnpm --filter @uh-oh/types build', { cwd: REPO });
run('pnpm --filter @uh-oh/react-native build', { cwd: REPO });

// ── 2. Stage ───────────────────────────────────────────────────────────────
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// ── 3. Copy SDK dist ───────────────────────────────────────────────────────
cpSync(join(REPO, 'packages/sdk/dist'), join(STAGE, 'dist'), { recursive: true });

// ── 4. Copy types dist into a known subdir of SDK dist ─────────────────────
const typesDest = join(STAGE, 'dist', TYPES_DIR_NAME);
cpSync(join(REPO, 'packages/types/dist'), typesDest, { recursive: true });

// ── 5. Rewrite '@uh-oh/types' refs in .d.ts and .js files to relative paths
function walkAndRewrite(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walkAndRewrite(p);
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
walkAndRewrite(join(STAGE, 'dist'));

// ── 6. Copy android source (drop build artifacts) ──────────────────────────
const androidSrc = join(REPO, 'packages/sdk/android');
const androidDst = join(STAGE, 'android');
cpSync(androidSrc, androidDst, {
  recursive: true,
  filter: (src) => {
    const rel = relative(androidSrc, src);
    return !rel.startsWith('build') && !rel.includes('/build/') && !rel.endsWith('/build');
  },
});

// ── 7. Flattened package.json ──────────────────────────────────────────────
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
  repository: { type: 'git', url: 'https://github.com/cunninghambe/uh-oh', directory: 'packages/sdk' },
  license: 'UNLICENSED',
  private: false,
};
writeFileSync(join(STAGE, 'package.json'), JSON.stringify(flat, null, 2) + '\n');

// ── 8. react-native autolinking config ─────────────────────────────────────
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

// ── 9. README pointer ──────────────────────────────────────────────────────
const headSha = runQuiet('git rev-parse HEAD', { cwd: REPO });
writeFileSync(
  join(STAGE, 'README.md'),
  `# @uh-oh/react-native

Auto-published from the \`main\` branch of https://github.com/cunninghambe/uh-oh via \`scripts/build-sdk-dist.mjs\`.

**Do not edit this branch by hand.** Run the script from \`main\` and force-push.

Built from \`main@${headSha.slice(0, 7)}\`.
`,
);

// ── 10. Push to sdk-dist orphan branch ─────────────────────────────────────
rmSync(TMP_REPO, { recursive: true, force: true });
const origin = runQuiet('git remote get-url origin', { cwd: REPO });
run(`git clone ${origin} ${TMP_REPO}`);
run(`git -C ${TMP_REPO} checkout --orphan ${BRANCH}`);
run(`git -C ${TMP_REPO} rm -rf .`);
for (const name of readdirSync(STAGE)) {
  cpSync(join(STAGE, name), join(TMP_REPO, name), { recursive: true });
}
run(`git -C ${TMP_REPO} add -A`);
run(`git -C ${TMP_REPO} commit -m "build: SDK dist from main@${headSha.slice(0, 7)}"`);
run(`git -C ${TMP_REPO} push --force origin ${BRANCH}`);

console.log(`\n✅ Published @uh-oh/react-native to ${BRANCH} branch (source commit ${headSha.slice(0, 7)})`);
console.log(`Consumers install via: pnpm add github:cunninghambe/uh-oh#${BRANCH}`);
