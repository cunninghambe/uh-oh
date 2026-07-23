import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { uploadNextSourcemaps } from './next-sourcemaps.js';
import type { NextSourcemapsDeps } from './next-sourcemaps.js';
import type { Config } from '../config.js';

type FetchCall = { url: string; init: RequestInit };

const makeStubFetch = (responses: Array<{ status: number; body: unknown }>): typeof fetch => {
  let callIndex = 0;
  return (_url, _init) => {
    const resp = responses[callIndex++];
    if (!resp) return Promise.reject(new Error('unexpected fetch call'));
    return Promise.resolve(
      new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
};

const makeCapturingFetch = (
  responses: Array<{ status: number; body: unknown }>,
  calls: FetchCall[],
): typeof fetch => {
  let callIndex = 0;
  return (url, init) => {
    calls.push({ url: url as string, init: init ?? {} });
    const resp = responses[callIndex++];
    if (!resp) return Promise.reject(new Error('unexpected fetch call'));
    return Promise.resolve(
      new Response(JSON.stringify(resp.body), {
        status: resp.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
};

const baseProject = { id: 'proj-1', slug: 'my-app', name: 'My App' };
const webRelease = { id: 'rel-web', version: '1.0.0', build: '42', platform: 'web' };
const nodeRelease = { id: 'rel-node', version: '1.0.0', build: '42', platform: 'node' };

// Fakes a build dir at "/app/.next" with two web maps and one node map.
// listFiles receives the *joined* root (e.g. "/app/.next/static") and
// returns paths relative to it, mirroring what fs.readdir(recursive) does.
const makeListFiles = (opts?: {
  staticFiles?: string[];
  serverFiles?: string[];
}): ((dir: string) => Promise<string[]>) => {
  const staticFiles = opts?.staticFiles ?? [
    path.join('chunks', 'main.js.map'),
    path.join('chunks', 'nested', 'page.js.map'),
  ];
  const serverFiles = opts?.serverFiles ?? [path.join('pages', 'index.js.map')];
  return (dir: string) => {
    const base = path.basename(dir);
    if (base === 'static') return Promise.resolve(staticFiles);
    if (base === 'server') return Promise.resolve(serverFiles);
    return Promise.resolve([]);
  };
};

const noCommit = (): Promise<string | undefined> => Promise.resolve(undefined);

const makeDeps = (
  cfg: Config | null,
  fetchResponses: Array<{ status: number; body: unknown }>,
  opts?: {
    listFiles?: (dir: string) => Promise<string[]>;
    statSize?: number;
    statFile?: (p: string) => Promise<{ size: number }>;
    resolveCommitSha?: (flagValue: string | undefined) => Promise<string | undefined>;
  },
): NextSourcemapsDeps & { logs: string[] } => {
  const logs: string[] = [];
  return {
    config: { read: () => Promise.resolve(cfg) },
    fetchFn: makeStubFetch(fetchResponses),
    log: (line) => logs.push(line),
    readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
    statFile: opts?.statFile ?? (() => Promise.resolve({ size: opts?.statSize ?? 1024 })),
    listFiles: opts?.listFiles ?? makeListFiles(),
    resolveCommitSha: opts?.resolveCommitSha ?? noCommit,
    logs,
  };
};

describe('uploadNextSourcemaps', () => {
  it('bad release format returns 1 without touching the filesystem or network', async () => {
    const deps = makeDeps(null, []);
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0',
      dir: '/app/.next',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/invalid release format/i);
  });

  it('no .js.map files anywhere reports and returns 0', async () => {
    const deps = makeDeps(null, [], { listFiles: () => Promise.resolve([]) });
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(0);
    expect(deps.logs[0]).toMatch(/no source maps found/i);
  });

  it('classifies static/ as web and server/ as node with forward-slash bundlePaths', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: NextSourcemapsDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [webRelease, nodeRelease] } },
          { status: 200, body: { release: webRelease } },
          { status: 200, body: { release: webRelease } },
          { status: 200, body: { release: nodeRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      listFiles: makeListFiles(),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });

    expect(code).toBe(0);
    expect(deps.logs.at(-1)).toBe('uploaded 2 web + 1 node maps (0 skipped)');

    // 2 GET calls (projects, releases) then 3 uploads (2 web, 1 node)
    expect(calls).toHaveLength(5);
    const uploadCalls = calls.slice(2);
    const bundlePaths = uploadCalls.map((c) => (c.init.body as FormData).get('bundlePath'));
    expect(bundlePaths.sort()).toEqual(
      ['static/chunks/main.js', 'static/chunks/nested/page.js', 'server/pages/index.js'].sort(),
    );
    const platforms = uploadCalls.map((c) => (c.init.body as FormData).get('platform'));
    expect(platforms.filter((p) => p === 'web')).toHaveLength(2);
    expect(platforms.filter((p) => p === 'node')).toHaveLength(1);
    expect(uploadCalls.every((c) => c.url.endsWith('/symbols'))).toBe(true);
    expect(uploadCalls[0]?.url).toContain('rel-web');
    expect(uploadCalls[2]?.url).toContain('rel-node');
  });

  it('normalizes this OS-native separator (path.sep) to forward slashes in bundlePath', async () => {
    const deps = makeDeps(
      { server: 'http://localhost:3300', token: 'tok' },
      [
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [webRelease] } },
        { status: 200, body: { release: webRelease } },
      ],
      {
        listFiles: makeListFiles({
          staticFiles: [path.join('chunks', 'main.js.map')],
          serverFiles: [],
        }),
      },
    );
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(0);
    expect(deps.logs.some((l) => l.includes('static/chunks/main.js'))).toBe(true);
  });

  it('not logged in returns 2', async () => {
    const deps = makeDeps(null, []);
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('project not found returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [] } },
    ]);
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/my-app not found/i);
  });

  it('creates a missing release via the idempotent upsert (asserting body) and uploads', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: NextSourcemapsDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [nodeRelease] } }, // no web release yet
          { status: 201, body: { release: webRelease } }, // upsert creates it
          { status: 200, body: { release: webRelease } },
          { status: 200, body: { release: webRelease } },
          { status: 200, body: { release: nodeRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      listFiles: makeListFiles(),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });

    expect(code).toBe(0);
    // Call 2 is the upsert: POST /api/projects/:id/releases with the parsed triple.
    expect(calls[2]?.url).toBe('http://localhost:3300/api/projects/proj-1/releases');
    expect(calls[2]?.init.method).toBe('POST');
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      version: '1.0.0',
      build: '42',
      platform: 'web',
    });
    expect((calls[2]?.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(deps.logs.some((l) => l === 'Created release 1.0.0+42 for platform web')).toBe(true);
    // Uploads then proceed for BOTH platforms against the resolved ids.
    expect(deps.logs.at(-1)).toBe('uploaded 2 web + 1 node maps (0 skipped)');
    expect(calls.slice(3).every((c) => c.url.endsWith('/symbols'))).toBe(true);
  });

  it('passes --commit through to resolveCommitSha and includes the resolved commitSha on every upsert', async () => {
    const calls: FetchCall[] = [];
    const seenFlagValues: Array<string | undefined> = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: NextSourcemapsDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [] } }, // neither platform exists yet
          { status: 201, body: { release: webRelease } }, // upsert web
          { status: 201, body: { release: nodeRelease } }, // upsert node
          { status: 200, body: { release: webRelease } }, // upload 1/3 (web)
          { status: 200, body: { release: webRelease } }, // upload 2/3 (web)
          { status: 200, body: { release: nodeRelease } }, // upload 3/3 (node)
        ],
        calls,
      ),
      log: () => {},
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      listFiles: makeListFiles(),
      resolveCommitSha: (flagValue) => {
        seenFlagValues.push(flagValue);
        return Promise.resolve('abc1234');
      },
      logs: [],
    };

    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
      commit: 'ABC1234',
    });

    expect(code).toBe(0);
    expect(seenFlagValues).toEqual(['ABC1234']);
    const upserts = calls.filter(
      (c) =>
        c.url === 'http://localhost:3300/api/projects/proj-1/releases' && c.init.method === 'POST',
    );
    expect(upserts).toHaveLength(2);
    for (const upsert of upserts) {
      expect(JSON.parse(upsert.init.body as string)).toMatchObject({ commitSha: 'abc1234' });
    }
  });

  it('omits commitSha from the upsert body when resolveCommitSha resolves nothing', async () => {
    const calls: FetchCall[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: NextSourcemapsDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [] } },
          { status: 201, body: { release: webRelease } }, // upsert web
          { status: 201, body: { release: nodeRelease } }, // upsert node
          { status: 200, body: { release: webRelease } }, // upload 1/3 (web)
          { status: 200, body: { release: webRelease } }, // upload 2/3 (web)
          { status: 200, body: { release: nodeRelease } }, // upload 3/3 (node)
        ],
        calls,
      ),
      log: () => {},
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      listFiles: makeListFiles(),
      resolveCommitSha: noCommit,
      logs: [],
    };

    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });

    expect(code).toBe(0);
    const upsert = calls.find(
      (c) =>
        c.url === 'http://localhost:3300/api/projects/proj-1/releases' && c.init.method === 'POST',
    );
    expect(upsert).toBeDefined();
    expect(JSON.parse(upsert?.init.body as string)).not.toHaveProperty('commitSha');
  });

  it('a failed release upsert fails only that platform and continues with the other', async () => {
    const deps = makeDeps(
      { server: 'http://localhost:3300', token: 'tok' },
      [
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [nodeRelease] } }, // no web release
        { status: 500, body: { error: 'upsert_failed' } }, // web upsert fails
        { status: 200, body: { release: nodeRelease } },
      ],
      undefined,
    );
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(1); // web files failed
    expect(deps.logs.some((l) => /could not create release .* for platform web/i.test(l))).toBe(
      true,
    );
    expect(deps.logs.at(-1)).toBe('uploaded 0 web + 1 node maps (0 skipped)');
  });

  it('skips files over 50 MB with a warning and keeps going', async () => {
    let call = 0;
    const deps = makeDeps(
      { server: 'http://localhost:3300', token: 'tok' },
      [
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [webRelease, nodeRelease] } },
        { status: 200, body: { release: webRelease } },
        { status: 200, body: { release: nodeRelease } },
      ],
      {
        statFile: () => {
          call++;
          // First web file (main.js.map) is oversized; the rest are fine.
          return Promise.resolve({ size: call === 1 ? 51 * 1024 * 1024 : 1024 });
        },
      },
    );
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(0);
    expect(deps.logs.some((l) => /exceeds the 50 mb cap/i.test(l))).toBe(true);
    expect(deps.logs.at(-1)).toBe('uploaded 1 web + 1 node maps (1 skipped)');
  });

  it('non-2xx on one file is reported, upload continues, and exit code is 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [webRelease, nodeRelease] } },
      { status: 500, body: { error: 'write_failed' } },
      { status: 200, body: { release: webRelease } },
      { status: 200, body: { release: nodeRelease } },
    ]);
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
    });
    expect(code).toBe(1);
    expect(deps.logs.some((l) => /upload failed for static/i.test(l))).toBe(true);
    expect(deps.logs.at(-1)).toBe('uploaded 1 web + 1 node maps (0 skipped)');
  });

  it('dry-run prints the plan and makes no network calls', async () => {
    const calls: FetchCall[] = [];
    const deps = makeDeps(null, [], {});
    deps.fetchFn = (url, init) => {
      calls.push({ url: url as string, init: init ?? {} });
      return Promise.reject(new Error('dry-run must not call fetch'));
    };
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(deps.logs.at(-1)).toBe('would upload 2 web + 1 node maps (0 skipped)');
    expect(deps.logs.some((l) => l.includes('[dry-run] web static/chunks/main.js'))).toBe(true);
  });

  it('dry-run still reports (and skips) oversized files using local stat only', async () => {
    let call = 0;
    const deps = makeDeps(null, [], {
      statFile: () => {
        call++;
        return Promise.resolve({ size: call === 1 ? 51 * 1024 * 1024 : 1024 });
      },
    });
    const code = await uploadNextSourcemaps(deps, {
      project: 'my-app',
      release: '1.0.0+42',
      dir: '/app/.next',
      dryRun: true,
    });
    expect(code).toBe(0);
    expect(deps.logs.at(-1)).toBe('would upload 1 web + 1 node maps (1 skipped)');
  });
});
