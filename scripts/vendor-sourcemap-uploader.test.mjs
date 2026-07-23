// Run with: node --test scripts/vendor-sourcemap-uploader.test.mjs
// node:test + node:assert (no vitest): scripts/ is not a workspace package.
//
// The generator emits a standalone uploader; these tests exercise both the
// generator (header/guard/no-em-dash) and the EMITTED script end-to-end by
// running it as a child process against a node:http stub of the uh-oh server.

/* global process */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMITTED_FILENAME,
  GENERATED_MARKER,
  UPLOADER_TEMPLATE,
  buildHeader,
  vendor,
} from './vendor-sourcemap-uploader.mjs';

/**
 * @typedef {{
 *   method: string | undefined,
 *   url: string | undefined,
 *   token: string | string[] | undefined,
 *   body: string,
 * }} StubRequest
 *
 * @typedef {{
 *   requests: StubRequest[],
 *   url: string,
 *   env: Record<string, string>,
 *   close: () => Promise<void>,
 * }} Stub
 */

/**
 * JSON.parse with an `unknown` (not `any`) return, so JSDoc casts of the
 * result satisfy the type-checked lint rules.
 * @param {string} s
 * @returns {unknown}
 */
function parseJson(s) {
  return JSON.parse(s);
}

/** @param {string} label */
function tmp(label) {
  return mkdtempSync(join(tmpdir(), `uh-oh-smu-${label}-`));
}

// The uh-oh repo checkout itself - a real git repo, used as a deterministic
// fixture for the "resolves via git rev-parse HEAD" tests below.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Emits the uploader into `dir` and returns its path.
 * @param {string} dir
 * @returns {string}
 */
function emit(dir) {
  const out = join(dir, EMITTED_FILENAME);
  vendor({ out });
  return out;
}

/**
 * Runs a node script as a child process with the four UH_OH_* vars stripped
 * from the base env (so the host machine's config can't leak into a test),
 * then applies `overrides` (a value of undefined deletes the key). `cwd`
 * controls where the script (and, for the commit tests, its internal `git
 * rev-parse HEAD`) runs; it defaults to this process's cwd when omitted.
 * @param {string} scriptPath
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [overrides]
 * @param {string} [cwd]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runNode(scriptPath, args, overrides = {}, cwd = undefined) {
  const env = { ...process.env };
  delete env.UH_OH_SERVER_URL;
  delete env.UH_OH_SYMBOL_TOKEN;
  delete env.UH_OH_PROJECT;
  delete env.UH_OH_COMMIT_SHA;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return new Promise((res) => {
    execFile(process.execPath, [scriptPath, ...args], { env, cwd }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      res({ code, stdout, stderr });
    });
  });
}

/**
 * Creates a minimal Next.js-style build tree with one web + one node map.
 * @param {string} build
 */
function makeFixture(build) {
  mkdirSync(join(build, 'static', 'chunks'), { recursive: true });
  mkdirSync(join(build, 'server', 'pages'), { recursive: true });
  writeFileSync(join(build, 'static', 'chunks', 'app.js.map'), '{"version":3,"file":"app.js"}');
  // A sibling non-map file must be ignored.
  writeFileSync(join(build, 'static', 'chunks', 'app.js'), 'console.log(1)');
  writeFileSync(join(build, 'server', 'pages', 'index.js.map'), '{"version":3,"file":"index.js"}');
}

/**
 * Extracts a text field value from an undici multipart/form-data body.
 * @param {string} body
 * @param {string} name
 * @returns {string | undefined}
 */
function field(body, name) {
  const re = new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)\\r\\n');
  const m = re.exec(body);
  return m ? m[1] : undefined;
}

/**
 * Starts a stub uh-oh server. Records every request. `failReleaseIds` makes the
 * symbols POST for those release ids return 500. `existingPlatforms` controls
 * which release rows the GET releases list already contains (default: both);
 * the release-upsert POST creates the missing ones (201) and is idempotent for
 * existing ones (200). `failUpsert` makes the upsert POST return 500.
 * @param {{
 *   project: string,
 *   version?: string,
 *   build?: string,
 *   failReleaseIds?: string[],
 *   existingPlatforms?: string[],
 *   failUpsert?: boolean,
 * }} opts
 * @returns {Promise<Stub>}
 */
function startStub(opts) {
  /** @type {StubRequest[]} */
  const requests = [];
  const failIds = new Set(opts.failReleaseIds ?? []);
  const platforms = new Set(opts.existingPlatforms ?? ['web', 'node']);
  const rowFor = (/** @type {string} */ platform) => ({
    id: `rel-${platform}`,
    version: opts.version,
    build: opts.build,
    platform,
  });
  const server = createServer((req, resp) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        token: req.headers['x-uh-oh-symbol-token'],
        body,
      });
      /**
       * @param {number} code
       * @param {unknown} obj
       */
      const sendJson = (code, obj) => {
        resp.writeHead(code, { 'content-type': 'application/json' });
        resp.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/api/projects') {
        sendJson(200, { projects: [{ id: 'proj-1', slug: opts.project }] });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/projects/proj-1/releases') {
        sendJson(200, { releases: [...platforms].map(rowFor) });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/projects/proj-1/releases') {
        if (opts.failUpsert) {
          resp.writeHead(500);
          resp.end('upsert rejected');
          return;
        }
        const parsed = /** @type {{ platform?: string }} */ (parseJson(body));
        const platform = parsed.platform ?? 'unknown';
        const created = !platforms.has(platform);
        platforms.add(platform);
        sendJson(created ? 201 : 200, { release: rowFor(platform) });
        return;
      }
      const m = /^\/api\/releases\/([^/]+)\/symbols$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        if (failIds.has(m[1])) {
          resp.writeHead(500);
          resp.end('upload rejected');
          return;
        }
        sendJson(200, { release: { id: m[1] } });
        return;
      }
      resp.writeHead(404);
      resp.end('not found');
    });
  });
  return new Promise((res) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
      const url = `http://127.0.0.1:${addr.port}`;
      res({
        requests,
        url,
        env: { UH_OH_SERVER_URL: url, UH_OH_SYMBOL_TOKEN: 'sym-tok', UH_OH_PROJECT: opts.project },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Generator: header, guard, no em-dash.
// ---------------------------------------------------------------------------

void test('emits a GENERATED header followed by the uploader body', () => {
  const dir = tmp('emit');
  try {
    const out = join(dir, EMITTED_FILENAME);
    const { target } = vendor({ out });
    const written = readFileSync(target, 'utf8');
    assert.ok(written.startsWith(`// ${GENERATED_MARKER}`), 'starts with the generated marker');
    assert.ok(written.includes(out), 'regen command echoes the target path');
    assert.ok(written.includes('async function main()'), 'uploader body present');
    assert.ok(written.includes('X-Uh-Oh-Symbol-Token'), 'sends the symbol-token header');
    assert.equal(written.includes('—'), false, 'emitted file must have no em dash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('the emitted header and template contain no U+2014 (em dash)', () => {
  assert.equal(buildHeader('some/target.mjs').includes('—'), false);
  assert.equal(UPLOADER_TEMPLATE.includes('—'), false);
});

void test('refuses to overwrite a hand-edited (non-generated) file', () => {
  const dir = tmp('guard');
  try {
    const out = join(dir, EMITTED_FILENAME);
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
    const out = join(dir, EMITTED_FILENAME);
    vendor({ out });
    const again = vendor({ out });
    assert.ok(readFileSync(again.target, 'utf8').includes(GENERATED_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Emitted script: env / arg handling.
// ---------------------------------------------------------------------------

void test('missing env is a clean no-op: one stderr line, exit 0', async () => {
  const dir = tmp('noop');
  try {
    const script = emit(dir);
    const r = await runNode(script, ['--dir', dir, '--release', '1.0.0+1']);
    assert.equal(r.code, 0);
    const lines = r.stderr.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${r.stderr}`);
    assert.match(r.stderr, /skipped/);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('--require turns missing env into a failure (exit 1)', async () => {
  const dir = tmp('require');
  try {
    const script = emit(dir);
    const r = await runNode(script, ['--dir', dir, '--release', '1.0.0+1', '--require']);
    assert.equal(r.code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('missing --dir exits 1 when configured', async () => {
  const dir = tmp('nodir');
  try {
    const script = emit(dir);
    const r = await runNode(script, ['--release', '1.0.0+1'], {
      UH_OH_SERVER_URL: 'http://127.0.0.1:1',
      UH_OH_SYMBOL_TOKEN: 't',
      UH_OH_PROJECT: 'p',
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('invalid --release exits 1 when configured', async () => {
  const dir = tmp('badrel');
  try {
    const script = emit(dir);
    const r = await runNode(script, ['--dir', dir, '--release', 'not-a-release'], {
      UH_OH_SERVER_URL: 'http://127.0.0.1:1',
      UH_OH_SYMBOL_TOKEN: 't',
      UH_OH_PROJECT: 'p',
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Emitted script: full upload round-trip against a stub server.
// ---------------------------------------------------------------------------

void test('uploads web + node maps with correct method, paths, headers, bundlePaths', async () => {
  const dir = tmp('upload');
  const stub = await startStub({ project: 'my-app', version: '1.4.2', build: '37' });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], stub.env);
    assert.equal(r.code, 0, r.stderr);

    assert.ok(
      stub.requests.every((q) => q.token === 'sym-tok'),
      'every request carries the X-Uh-Oh-Symbol-Token header',
    );

    const gets = stub.requests.filter((q) => q.method === 'GET');
    const posts = stub.requests.filter((q) => q.method === 'POST');
    assert.ok(
      gets.some((q) => q.url === '/api/projects'),
      'resolves the project via GET /api/projects',
    );
    assert.ok(
      gets.some((q) => q.url === '/api/projects/proj-1/releases'),
      'resolves releases via GET /api/projects/:id/releases',
    );
    assert.equal(posts.length, 2, 'one symbols POST per map');
    assert.equal(
      posts.filter((q) => q.url === '/api/projects/proj-1/releases').length,
      0,
      'no release upsert when the rows already exist',
    );

    const webPost = posts.find((q) => q.url === '/api/releases/rel-web/symbols');
    const nodePost = posts.find((q) => q.url === '/api/releases/rel-node/symbols');
    assert.ok(webPost, 'web map posted to the web release');
    assert.ok(nodePost, 'node map posted to the node release');

    assert.equal(field(webPost.body, 'platform'), 'web');
    assert.equal(field(webPost.body, 'bundlePath'), 'static/chunks/app.js');
    assert.equal(field(nodePost.body, 'platform'), 'node');
    assert.equal(field(nodePost.body, 'bundlePath'), 'server/pages/index.js');

    assert.match(r.stdout, /uploaded 1 web \+ 1 node maps/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('creates missing releases via the idempotent upsert, then uploads', async () => {
  const dir = tmp('upsert');
  // The server has seen NO releases yet - the pre-first-event deploy case.
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], stub.env);
    assert.equal(r.code, 0, r.stderr);

    const upserts = stub.requests.filter(
      (q) => q.method === 'POST' && q.url === '/api/projects/proj-1/releases',
    );
    assert.equal(upserts.length, 2, 'one upsert per missing platform');
    assert.ok(
      upserts.every((q) => q.token === 'sym-tok'),
      'upserts carry the X-Uh-Oh-Symbol-Token header',
    );
    const bodies = upserts.map((q) => /** @type {Record<string, string>} */ (parseJson(q.body)));
    assert.deepEqual(
      bodies.map((b) => b.platform).sort(),
      ['node', 'web'],
      'upserts one web + one node release',
    );
    for (const b of bodies) {
      assert.equal(b.version, '1.4.2', 'upsert body carries the parsed version');
      assert.equal(b.build, '37', 'upsert body carries the parsed build');
    }

    const symbolPosts = stub.requests.filter(
      (q) => q.method === 'POST' && /\/symbols$/.test(q.url ?? ''),
    );
    assert.equal(symbolPosts.length, 2, 'uploads proceed against the created releases');
    assert.ok(symbolPosts.some((q) => q.url === '/api/releases/rel-web/symbols'));
    assert.ok(symbolPosts.some((q) => q.url === '/api/releases/rel-node/symbols'));

    assert.match(r.stdout, /created release 1\.4\.2\+37 for platform web/);
    assert.match(r.stdout, /created release 1\.4\.2\+37 for platform node/);
    assert.match(r.stdout, /uploaded 1 web \+ 1 node maps/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('a failed release upsert fails those maps (exit 1) and uploads nothing for them', async () => {
  const dir = tmp('upsert-fail');
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
    failUpsert: true,
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], stub.env);
    assert.equal(r.code, 1, 'upsert failure is a hard failure');
    assert.match(r.stderr, /could not create release/);
    const symbolPosts = stub.requests.filter(
      (q) => q.method === 'POST' && /\/symbols$/.test(q.url ?? ''),
    );
    assert.equal(symbolPosts.length, 0, 'no uploads without a release id');
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Emitted script: --delete-browser-maps semantics.
// ---------------------------------------------------------------------------

void test('--delete-browser-maps removes browser maps only after all uploads succeed', async () => {
  const dir = tmp('del-ok');
  const stub = await startStub({ project: 'my-app', version: '1.0.0', build: '5' });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const webMap = join(build, 'static', 'chunks', 'app.js.map');
    const nodeMap = join(build, 'server', 'pages', 'index.js.map');
    const script = emit(dir);
    const r = await runNode(
      script,
      ['--dir', build, '--release', '1.0.0+5', '--delete-browser-maps'],
      stub.env,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(webMap), false, 'the browser map is deleted');
    assert.equal(existsSync(nodeMap), true, 'the server map is retained');
    assert.match(r.stdout, /deleted 1 browser source map/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('--delete-browser-maps keeps maps when any upload fails (exit 1)', async () => {
  const dir = tmp('del-fail');
  const stub = await startStub({
    project: 'my-app',
    version: '1.0.0',
    build: '5',
    failReleaseIds: ['rel-web'],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const webMap = join(build, 'static', 'chunks', 'app.js.map');
    const script = emit(dir);
    const r = await runNode(
      script,
      ['--dir', build, '--release', '1.0.0+5', '--delete-browser-maps'],
      stub.env,
    );
    assert.equal(r.code, 1, 'a failed upload exits 1');
    assert.equal(existsSync(webMap), true, 'the browser map is retained on failure');
    assert.match(r.stderr, /not deleting browser source maps/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Emitted script: dry-run.
// ---------------------------------------------------------------------------

void test('--dry-run lists maps and makes no network requests', async () => {
  const dir = tmp('dry');
  const stub = await startStub({ project: 'my-app', version: '1.0.0', build: '1' });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(
      script,
      ['--dir', build, '--release', '1.0.0+1', '--dry-run'],
      stub.env,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(stub.requests.length, 0, 'dry-run issues no requests');
    assert.match(r.stdout, /\[dry-run\] web static\/chunks\/app\.js/);
    assert.match(r.stdout, /would upload 1 web \+ 1 node/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Emitted script: commit resolution (UH_OH_COMMIT_SHA / git rev-parse HEAD).
// ---------------------------------------------------------------------------

void test('sends the resolved UH_OH_COMMIT_SHA (lowercased) on every release upsert', async () => {
  const dir = tmp('commit-env');
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], {
      ...stub.env,
      UH_OH_COMMIT_SHA: 'ABCDEF1',
    });
    assert.equal(r.code, 0, r.stderr);

    const upserts = stub.requests.filter(
      (q) => q.method === 'POST' && q.url === '/api/projects/proj-1/releases',
    );
    assert.equal(upserts.length, 2, 'one upsert per missing platform');
    for (const upsert of upserts) {
      const body = /** @type {{ commitSha?: string }} */ (parseJson(upsert.body));
      assert.equal(body.commitSha, 'abcdef1', 'commitSha is sent lowercased');
    }
    assert.equal(r.stdout.includes('omitting commitSha'), false);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('an invalid UH_OH_COMMIT_SHA is omitted with exactly one log line, and upserts still succeed', async () => {
  const dir = tmp('commit-env-bad');
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], {
      ...stub.env,
      UH_OH_COMMIT_SHA: 'not-a-sha',
    });
    assert.equal(r.code, 0, r.stderr);

    const upserts = stub.requests.filter(
      (q) => q.method === 'POST' && q.url === '/api/projects/proj-1/releases',
    );
    assert.equal(upserts.length, 2, 'one upsert per missing platform');
    for (const upsert of upserts) {
      const body = /** @type {{ commitSha?: string }} */ (parseJson(upsert.body));
      assert.equal(Object.hasOwn(body, 'commitSha'), false, 'commitSha is omitted, not sent empty');
    }

    const lines = r.stdout.split('\n').filter((l) => l.includes('omitting commitSha'));
    assert.equal(lines.length, 1, `expected exactly one log line, got:\n${r.stdout}`);
    assert.match(lines[0], /ignoring invalid UH_OH_COMMIT_SHA/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('falls back to `git rev-parse HEAD` when UH_OH_COMMIT_SHA is unset, resolving the real HEAD of cwd', async () => {
  const dir = tmp('commit-git');
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim()
      .toLowerCase();

    const r = await runNode(script, ['--dir', build, '--release', '1.4.2+37'], stub.env, REPO_ROOT);
    assert.equal(r.code, 0, r.stderr);

    const upserts = stub.requests.filter(
      (q) => q.method === 'POST' && q.url === '/api/projects/proj-1/releases',
    );
    assert.equal(upserts.length, 2);
    for (const upsert of upserts) {
      const body = /** @type {{ commitSha?: string }} */ (parseJson(upsert.body));
      assert.equal(body.commitSha, expectedSha);
    }
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('omits commitSha with exactly one log line when run outside any git repository', async () => {
  const nonGitRoot = tmp('commit-nogit');
  const dir = tmp('commit-nogit-build');
  const stub = await startStub({
    project: 'my-app',
    version: '1.4.2',
    build: '37',
    existingPlatforms: [],
  });
  try {
    const build = join(dir, '.next');
    makeFixture(build);
    const script = emit(dir);
    const r = await runNode(
      script,
      ['--dir', build, '--release', '1.4.2+37'],
      stub.env,
      nonGitRoot,
    );
    assert.equal(r.code, 0, r.stderr);

    const upserts = stub.requests.filter(
      (q) => q.method === 'POST' && q.url === '/api/projects/proj-1/releases',
    );
    assert.equal(upserts.length, 2);
    for (const upsert of upserts) {
      const body = /** @type {{ commitSha?: string }} */ (parseJson(upsert.body));
      assert.equal(Object.hasOwn(body, 'commitSha'), false);
    }

    const lines = r.stdout.split('\n').filter((l) => l.includes('omitting commitSha'));
    assert.equal(lines.length, 1, `expected exactly one log line, got:\n${r.stdout}`);
    assert.match(lines[0], /no commit SHA resolved/);
  } finally {
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(nonGitRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Generator: commit-resolution logic is present in the emitted output.
// ---------------------------------------------------------------------------

void test('the generator output contains the commit-resolution logic, still has no em dash, and still parses', () => {
  const dir = tmp('commit-static');
  try {
    for (const src of [UPLOADER_TEMPLATE, buildHeader('x')]) {
      assert.equal(src.includes('—'), false, 'no em dash');
    }
    assert.ok(UPLOADER_TEMPLATE.includes('UH_OH_COMMIT_SHA'), 'reads the env var');
    assert.ok(UPLOADER_TEMPLATE.includes('gitRevParseHead'), 'has the guarded git helper');
    assert.ok(UPLOADER_TEMPLATE.includes('resolveCommitSha'), 'has the resolver');
    assert.ok(UPLOADER_TEMPLATE.includes('COMMIT_SHA_RE'), 'validates against the SHA regex');
    assert.ok(UPLOADER_TEMPLATE.includes('commitSha'), 'sends commitSha on the upsert');

    const script = emit(dir);
    const written = readFileSync(script, 'utf8');
    assert.equal(written.includes('—'), false, 'emitted file has no em dash');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test('the emitted script is syntactically valid (node --check)', async () => {
  const dir = tmp('commit-syntax');
  try {
    const script = emit(dir);
    await new Promise((resolvePromise, rejectPromise) => {
      execFile(process.execPath, ['--check', script], (err, _stdout, stderr) => {
        if (err) rejectPromise(new Error(stderr || err.message));
        else resolvePromise(undefined);
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
