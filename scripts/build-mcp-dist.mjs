#!/usr/bin/env node
// Builds @uh-oh/mcp as a self-contained, npm-installable package and
// force-pushes it to the `mcp-dist` branch on origin (mirroring build-js-dist
// / build-sdk-dist). Consumers install the MCP server via
// `pnpm add github:cunninghambe/uh-oh#mcp-dist` and run the `uh-oh-mcp` bin, or
// point `claude mcp add` straight at the installed binary.
//
// Unlike @uh-oh/js (a single dependency-free source file), @uh-oh/mcp ships a
// compiled multi-file `dist/` plus its two runtime dependencies
// (@modelcontextprotocol/sdk + zod), pinned to the versions the workspace
// resolved. The `bin` field is preserved so `uh-oh-mcp` stays runnable.
//
// Run from the uh-oh repo root:
//   node scripts/build-mcp-dist.mjs
//
// Requirements: pnpm, git, write access to origin. Cross-platform
// (os.tmpdir() + path.join throughout, temp paths quoted for shells).

/* global console, process */

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const STAGE = join(os.tmpdir(), 'uh-oh-mcp-dist-stage');
const TMP_REPO = join(os.tmpdir(), 'uh-oh-mcp-dist-repo');
const BRANCH = 'mcp-dist';

// Exported so build-mcp-dist.test.mjs can unit-test the flattening rules
// (private flag stripped, bin + entry points preserved, only the two runtime
// deps carried) without running the publish flow.
/**
 * @param {Record<string, unknown>} orig - packages/mcp/package.json contents
 * @returns {Record<string, unknown>}
 */
export function buildFlatPackageJson(orig) {
  return {
    name: orig.name,
    version: orig.version,
    description:
      'MCP server and tool registry for uh-oh self-hosted crash reporting (stdio bin: uh-oh-mcp).',
    type: orig.type,
    main: orig.main,
    types: orig.types,
    exports: orig.exports,
    bin: orig.bin,
    files: ['dist', 'README.md'],
    // Pinned to the versions the workspace resolved (packages/mcp/package.json
    // uses exact versions under save-exact, so these ARE the resolved versions).
    dependencies: orig.dependencies,
    repository: {
      type: 'git',
      url: 'https://github.com/cunninghambe/uh-oh',
      directory: 'packages/mcp',
    },
    license: 'MIT',
    private: false,
  };
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

function publish() {
  // ── 1. Verify clean state and build ──────────────────────────────────────
  const status = runQuiet('git status --porcelain', { cwd: REPO });
  if (status) {
    console.error('ERROR: working tree is dirty. Commit or stash before publishing.');
    console.error(status);
    process.exit(1);
  }

  run('pnpm --filter @uh-oh/mcp build', { cwd: REPO });

  // ── 2. Stage ─────────────────────────────────────────────────────────────
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  cpSync(join(REPO, 'packages/mcp/dist'), join(STAGE, 'dist'), { recursive: true });

  // ── 3. Flattened package.json ────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
  const orig = JSON.parse(readFileSync(join(REPO, 'packages/mcp/package.json'), 'utf8'));
  const flat = buildFlatPackageJson(orig);
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
  writeFileSync(join(STAGE, 'package.json'), JSON.stringify(flat, null, 2) + '\n');

  // ── 4. README pointer ────────────────────────────────────────────────────
  const headSha = runQuiet('git rev-parse HEAD', { cwd: REPO });
  writeFileSync(
    join(STAGE, 'README.md'),
    `# @uh-oh/mcp

Auto-published from the \`main\` branch of https://github.com/cunninghambe/uh-oh via \`scripts/build-mcp-dist.mjs\`.

**Do not edit this branch by hand.** Run the script from \`main\` and force-push.

Install: \`pnpm add github:cunninghambe/uh-oh#mcp-dist\`
Then run the stdio MCP server (needs UH_OH_SERVER_URL + UH_OH_ADMIN_PASSWORD): \`uh-oh-mcp\`.

Built from \`main@${headSha.slice(0, 7)}\`.
`,
  );

  // ── 5. Push to mcp-dist orphan branch ────────────────────────────────────
  rmSync(TMP_REPO, { recursive: true, force: true });
  const origin = runQuiet('git remote get-url origin', { cwd: REPO });
  run(`git clone ${origin} "${TMP_REPO}"`);
  run(`git -C "${TMP_REPO}" checkout --orphan ${BRANCH}`);
  run(`git -C "${TMP_REPO}" rm -rf .`);
  for (const name of readdirSync(STAGE)) {
    cpSync(join(STAGE, name), join(TMP_REPO, name), { recursive: true });
  }
  run(`git -C "${TMP_REPO}" add -A`);
  run(`git -C "${TMP_REPO}" commit -m "build: MCP dist from main@${headSha.slice(0, 7)}"`);
  run(`git -C "${TMP_REPO}" push --force origin ${BRANCH}`);

  console.log(
    `\n✅ Published @uh-oh/mcp to ${BRANCH} branch (source commit ${headSha.slice(0, 7)})`,
  );
  console.log(`Consumers install via: pnpm add github:cunninghambe/uh-oh#${BRANCH}`);
}

const isEntryPoint =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  publish();
}
