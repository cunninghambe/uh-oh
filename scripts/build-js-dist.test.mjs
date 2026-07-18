// Unit tests for the exported helper of build-js-dist.mjs. Importing the
// module must not trigger the publish flow (guarded by the entry-point check
// at the bottom of the script, same pattern as build-sdk-dist.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFlatPackageJson } from './build-js-dist.mjs';

const ORIG = {
  name: '@uh-oh/js',
  version: '0.5.0',
  private: true,
  type: 'module',
  main: './dist/uh-oh-client.js',
  types: './dist/uh-oh-client.d.ts',
  exports: {
    '.': {
      types: './dist/uh-oh-client.d.ts',
      import: './dist/uh-oh-client.js',
    },
  },
  scripts: { build: 'tsc -p tsconfig.build.json' },
  devDependencies: { vitest: '4.1.6' },
};

void test('strips the private flag', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.equal(flat.private, false);
});

void test('preserves name, version, type, entry points, and exports', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.equal(flat.name, '@uh-oh/js');
  assert.equal(flat.version, '0.5.0');
  assert.equal(flat.type, 'module');
  assert.equal(flat.main, './dist/uh-oh-client.js');
  assert.equal(flat.types, './dist/uh-oh-client.d.ts');
  assert.deepEqual(flat.exports, ORIG.exports);
});

void test('ships dist, src, and README only; carries no dependencies or scripts', () => {
  const flat = buildFlatPackageJson(ORIG);
  assert.deepEqual(flat.files, ['dist', 'src', 'README.md']);
  assert.equal(flat.scripts, undefined);
  assert.equal(flat.devDependencies, undefined);
  assert.equal(flat.dependencies, undefined);
});
