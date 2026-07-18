#!/usr/bin/env node
// Vendors the single-file @uh-oh/js client into a consumer repo.
//
//   node scripts/vendor-js-client.mjs --out <target-path>
//
// Copies packages/js/src/uh-oh-client.ts verbatim to <target-path>, prepending
// a GENERATED header. Refuses to clobber a file that exists and lacks that
// header (so a hand-edited file is never silently overwritten).
//
// Cross-platform: uses node:os / node:path throughout (like build-sdk-dist.mjs)
// so it works on the Windows dev box and on Linux/macOS CI alike.
//
// NOTE: the emitted header contains no U+2014 (em dash) - the client file is
// vendored verbatim into a consumer repo that lints for that character, and the
// header rides in front of it. Keep both em-dash-free.

/* global console, process */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

export const CLIENT_SOURCE = join(REPO, 'packages', 'js', 'src', 'uh-oh-client.ts');
export const CLIENT_VERSION = '0.4.0';
export const GENERATED_MARKER = 'GENERATED FILE - vendored from uh-oh';

/**
 * Builds the header prepended to the vendored file.
 * @param {string} outPath the raw --out argument, echoed into the regen command
 * @returns {string}
 */
export function buildHeader(outPath) {
  return (
    [
      `// ${GENERATED_MARKER} packages/js/src/uh-oh-client.ts (v${CLIENT_VERSION}).`,
      `// Do not hand-edit. Regenerate: node scripts/vendor-js-client.mjs --out ${outPath}`,
      '// Replace with `npm add github:cunninghambe/uh-oh#js-dist` once that branch is published.',
    ].join('\n') + '\n\n'
  );
}

/**
 * @param {{ out: string, source?: string }} opts
 * @returns {{ target: string, bytes: number }}
 */
export function vendor(opts) {
  const out = opts.out;
  if (!out) throw new Error('vendor: --out <target-path> is required');
  const source = opts.source ?? CLIENT_SOURCE;
  const target = resolve(out);

  const client = readFileSync(source, 'utf8');

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (!existing.includes(GENERATED_MARKER)) {
      throw new Error(
        `vendor: refusing to overwrite ${target} - it exists and is not a generated file`,
      );
    }
  }

  const contents = buildHeader(out) + client;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return { target, bytes: contents.length };
}

/**
 * @param {string[]} argv
 * @returns {{ out?: string }}
 */
function parseArgs(argv) {
  /** @type {{ out?: string }} */
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const value = argv[i + 1];
      if (value !== undefined) args.out = value;
      i++;
    }
  }
  return args;
}

const isEntryPoint =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (!args.out) throw new Error('usage: node scripts/vendor-js-client.mjs --out <target-path>');
    const { target, bytes } = vendor({ out: args.out });
    console.log(`Vendored uh-oh-client.ts -> ${target} (${bytes} bytes)`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
