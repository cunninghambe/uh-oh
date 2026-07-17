// Run with: node --test scripts/vendor-js-client.test.mjs
// node:test + node:assert (no vitest): scripts/ is not a workspace package and
// has no vitest devDependency.

/* global process */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLIENT_SOURCE, GENERATED_MARKER, buildHeader, vendor } from './vendor-js-client.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// A deliberately hostile tsconfig: strict, no DOM lib, no Node types. If the
// vendored client compiles here, it will compile in a foreign consumer repo
// (Next.js) whose tsconfig omits one or both ambient type sets.
const STRICT_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    target: 'ES2022',
    lib: ['ES2022'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    types: [],
    skipLibCheck: false,
    noEmit: true,
    forceConsistentCasingInFileNames: true,
  },
  include: ['uh-oh-client.ts'],
};

/**
 * @param {string} dir
 * @returns {Promise<{ code: number, output: string }>}
 */
function runTsc(dir) {
  return new Promise((resolvePromise) => {
    const tscBin = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
    execFile(
      process.execPath,
      [tscBin, '-p', join(dir, 'tsconfig.json')],
      { cwd: dir },
      (err, stdout, stderr) => {
        resolvePromise({ code: err ? 1 : 0, output: `${stdout}${stderr}` });
      },
    );
  });
}

/** @param {string} label */
function tmp(label) {
  return mkdtempSync(join(tmpdir(), `uh-oh-${label}-`));
}

void test('the client source contains no U+2014 (em dash)', () => {
  const src = readFileSync(CLIENT_SOURCE, 'utf8');
  assert.equal(src.includes('—'), false, 'uh-oh-client.ts must not contain an em dash');
});

void test('the emitted header contains no U+2014 (em dash)', () => {
  assert.equal(buildHeader('some/target.ts').includes('—'), false);
});

void test('vendors a GENERATED header followed by the verbatim client body', () => {
  const dir = tmp('vendor');
  try {
    const out = join(dir, 'uh-oh-client.ts');
    const { target } = vendor({ out });
    const written = readFileSync(target, 'utf8');
    assert.ok(written.startsWith(`// ${GENERATED_MARKER}`), 'starts with the generated marker');
    assert.ok(written.includes(out), 'regen command echoes the target path');
    assert.ok(written.includes('export function init('), 'client body copied verbatim');
    assert.equal(written.includes('—'), false, 'vendored file must have no em dash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('refuses to overwrite a hand-edited (non-generated) file', () => {
  const dir = tmp('guard');
  try {
    const out = join(dir, 'client.ts');
    const original = '// hand written, do not touch\n';
    writeFileSync(out, original);
    assert.throws(() => vendor({ out }), /refusing to overwrite/);
    assert.equal(readFileSync(out, 'utf8'), original, 'the file is left untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('overwrites a previously generated file', () => {
  const dir = tmp('regen');
  try {
    const out = join(dir, 'client.ts');
    vendor({ out });
    const again = vendor({ out });
    assert.ok(readFileSync(again.target, 'utf8').includes(GENERATED_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('vendored output compiles under strict TS with neither DOM nor Node libs', async () => {
  const dir = tmp('tsc');
  try {
    vendor({ out: join(dir, 'uh-oh-client.ts') });
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(STRICT_TSCONFIG, null, 2));
    const { code, output } = await runTsc(dir);
    assert.equal(code, 0, `tsc reported errors on the vendored client:\n${output}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
