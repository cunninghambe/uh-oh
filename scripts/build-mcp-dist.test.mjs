// Unit tests for the exported helper of build-mcp-dist.mjs. Importing the
// module must not trigger the publish flow (guarded by the entry-point check
// at the bottom of the script, same pattern as build-js-dist.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFlatPackageJson } from './build-mcp-dist.mjs';

const ORIG = {
  name: '@uh-oh/mcp',
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  bin: { 'uh-oh-mcp': './dist/stdio.js' },
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
  },
  scripts: { build: 'tsc -p tsconfig.build.json' },
  dependencies: { '@modelcontextprotocol/sdk': '1.29.0', zod: '4.4.3' },
  devDependencies: { vitest: '4.1.6' },
};

void test('strips the private flag', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.equal(flat.private, false);
});

void test('preserves name, version, type, entry points, exports, and bin', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.equal(flat.name, '@uh-oh/mcp');
  assert.equal(flat.version, '0.1.0');
  assert.equal(flat.type, 'module');
  assert.equal(flat.main, './dist/index.js');
  assert.equal(flat.types, './dist/index.d.ts');
  assert.deepEqual(flat.exports, ORIG.exports);
  assert.deepEqual(flat.bin, { 'uh-oh-mcp': './dist/stdio.js' });
});

void test('carries the two runtime deps pinned to the workspace versions', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.deepEqual(flat.dependencies, { '@modelcontextprotocol/sdk': '1.29.0', zod: '4.4.3' });
});

void test('ships dist + README only; carries no scripts or devDependencies', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.deepEqual(flat.files, ['dist', 'README.md']);
  assert.equal(flat.scripts, undefined);
  assert.equal(flat.devDependencies, undefined);
});
