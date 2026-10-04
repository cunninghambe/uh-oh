// Run with: node --test scripts/prettier-eol.test.mjs
// node:test + node:assert (no vitest): scripts/ is not a workspace package.
//
// Line endings and the format gate. Git for Windows ships core.autocrlf=true, so
// a Windows checkout of this repo has CRLF in the working tree while every blob
// in the index is LF. With Prettier's default endOfLine ('lf', also implied by
// .editorconfig) the local `pnpm format:check` then flagged about 314 clean
// files on Windows and buried any real formatting failure among them.
//
// The fix has two halves, and these tests pin both:
//   1. .prettierrc sets endOfLine 'auto', so the local gate accepts a CRLF
//      working copy of correctly formatted code.
//   2. CI (ubuntu, LF checkout) runs `pnpm format:check --end-of-line lf`, and a
//      CLI flag outranks the config file, so a CRLF blob still fails CI.

/* global process */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRETTIERRC = join(ROOT, '.prettierrc');
const PRETTIER_BIN = join(
  dirname(createRequire(import.meta.url).resolve('prettier/package.json')),
  'bin',
  'prettier.cjs',
);

// Already in this repo's Prettier style, so only the line endings vary.
const LF_SOURCE = 'export const answer = 42;\n\nexport function twice(n) {\n  return n * 2;\n}\n';
const CRLF_SOURCE = LF_SOURCE.replace(/\n/g, '\r\n');

/**
 * The options `prettier --check` would use for a file at this repo path.
 * @param {string} relPath
 */
async function repoOptions(relPath) {
  const filepath = join(ROOT, relPath);
  const config = await prettier.resolveConfig(filepath, { editorconfig: true });
  return { ...config, filepath };
}

/**
 * Runs the Prettier CLI with --check on a temp file; returns its exit code.
 * @param {string} source
 * @param {string[]} extraArgs
 */
function cliCheck(source, extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'uh-oh-eol-'));
  const file = join(dir, 'sample.mjs');
  writeFileSync(file, source);
  try {
    execFileSync(
      process.execPath,
      [PRETTIER_BIN, '--check', '--config', PRETTIERRC, ...extraArgs, file],
      {
        stdio: 'pipe',
      },
    );
    return 0;
  } catch (err) {
    return /** @type {{ status: number }} */ (err).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void test('the repo config accepts a CRLF working copy of formatted code (Windows checkout)', async () => {
  for (const rel of ['scripts/vendor-js-client.mjs', 'packages/server/src/app.ts', 'SPEC.md']) {
    const options = await repoOptions(rel);
    assert.equal(options.endOfLine, 'auto', `${rel} resolves endOfLine 'auto'`);
  }
  const options = await repoOptions('scripts/vendor-js-client.mjs');
  assert.equal(await prettier.check(CRLF_SOURCE, options), true, 'CRLF copy passes');
  assert.equal(await prettier.check(LF_SOURCE, options), true, 'LF copy passes');
});

void test('the repo config still flags real formatting problems', async () => {
  const options = await repoOptions('scripts/vendor-js-client.mjs');
  const badLf = 'export const answer = 42\n'; // missing semicolon
  assert.equal(await prettier.check(badLf, options), false);
  assert.equal(await prettier.check(badLf.replace(/\n/g, '\r\n'), options), false);
});

void test('the local CLI gate passes a CRLF file under the repo config', () => {
  assert.equal(cliCheck(CRLF_SOURCE, []), 0);
});

void test('--end-of-line lf on the CLI overrides the config, so CRLF fails and LF passes', () => {
  assert.equal(cliCheck(CRLF_SOURCE, ['--end-of-line', 'lf']), 1);
  assert.equal(cliCheck(LF_SOURCE, ['--end-of-line', 'lf']), 0);
});

void test('CI runs the format gate with --end-of-line lf, so committed blobs stay LF', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const step = ci.match(/- name: Format check[\s\S]*?run: (.+)/);
  assert.ok(step, 'ci.yml has a "Format check" step');
  assert.match(step[1].trim(), /^pnpm format:check --end-of-line lf$/);
});
