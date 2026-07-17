// Run with: node --test scripts/build-sdk-dist.test.mjs
// Deliberately node:test + node:assert (no vitest): this is a standalone repo
// script, not a workspace package, so it has no vitest devDependency and
// nothing here should require `pnpm install` to add one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGradleBuildOutputPath } from './build-sdk-dist.mjs';

// `void` on each call: node:test's test() returns a promise that resolves
// when the test finishes, which @typescript-eslint/no-floating-promises
// (correctly) wants handled — node:test itself is what awaits/schedules
// these under the hood, so there's nothing for us to await here.

void test('excludes the top-level build directory', () => {
  assert.equal(isGradleBuildOutputPath('build'), true);
});

void test('excludes files inside the top-level build directory', () => {
  assert.equal(isGradleBuildOutputPath('build/outputs/aar/sdk.aar'), true);
});

void test('excludes nested module build directories', () => {
  assert.equal(isGradleBuildOutputPath('app/build'), true);
  assert.equal(isGradleBuildOutputPath('app/build/intermediates/foo'), true);
});

void test('excludes build directories on Windows-style paths', () => {
  assert.equal(isGradleBuildOutputPath('build\\outputs\\aar\\sdk.aar'), true);
  assert.equal(isGradleBuildOutputPath('app\\build\\intermediates'), true);
});

void test('does NOT exclude build.gradle (the regression this guards against)', () => {
  assert.equal(isGradleBuildOutputPath('build.gradle'), false);
});

void test('does NOT exclude other files/dirs that merely start with "build"', () => {
  assert.equal(isGradleBuildOutputPath('build.gradle.kts'), false);
  assert.equal(isGradleBuildOutputPath('build-tools-notes.md'), false);
  assert.equal(isGradleBuildOutputPath('builder/foo.txt'), false);
});

void test('does NOT exclude normal source paths', () => {
  assert.equal(isGradleBuildOutputPath('src/main/AndroidManifest.xml'), false);
  assert.equal(isGradleBuildOutputPath('gradle.properties'), false);
});

void test('does NOT exclude the root itself (empty relative path)', () => {
  assert.equal(isGradleBuildOutputPath(''), false);
});
