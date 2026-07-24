import { describe, it, expect } from 'vitest';
import { upload } from './upload.js';
import type { UploadDeps } from './upload.js';
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
const baseRelease = { id: 'rel-1', version: '1.0.0', build: '1', platform: 'android' };

const noCommit = (): Promise<string | undefined> => Promise.resolve(undefined);

const makeDeps = (
  cfg: Config | null,
  fetchResponses: Array<{ status: number; body: unknown }>,
  opts?: {
    fileContent?: Buffer;
    statSize?: number;
    resolveCommitSha?: (flagValue: string | undefined) => Promise<string | undefined>;
  },
): UploadDeps & { logs: string[] } => {
  const logs: string[] = [];
  return {
    config: { read: () => Promise.resolve(cfg) },
    fetchFn: makeStubFetch(fetchResponses),
    log: (line) => logs.push(line),
    readFile: () => Promise.resolve(opts?.fileContent ?? Buffer.from('fake content')),
    statFile: () => Promise.resolve({ size: opts?.statSize ?? 1024 }),
    resolveCommitSha: opts?.resolveCommitSha ?? noCommit,
    logs,
  };
};

describe('upload command', () => {
  it('missing config returns 2', async () => {
    const deps = makeDeps(null, []);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('config without token returns 2', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300' }, []);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('bad release format (no plus) returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, []);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0',
      file: 'mapping.txt',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/invalid release format/i);
  });

  it('bad release format (leading plus) returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, []);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '+42',
      file: 'mapping.txt',
    });
    expect(code).toBe(1);
  });

  it('project not found returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
    ]);
    const code = await upload(deps, 'mapping', {
      project: 'other-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/other-app not found/i);
  });

  it('release not found returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [] } },
    ]);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/not yet seen by the server/i);
  });

  it('file too large returns 1 without reading the file into memory', async () => {
    const logs: string[] = [];
    let readFileCalled = false;
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve({ server: 'http://localhost:3300', token: 'tok' }) },
      fetchFn: makeStubFetch([
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [baseRelease] } },
      ]),
      log: (line) => logs.push(line),
      readFile: () => {
        readFileCalled = true;
        return Promise.resolve(Buffer.from('x'));
      },
      statFile: () => Promise.resolve({ size: 51 * 1024 * 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });

    expect(code).toBe(1);
    expect(logs[0]).toMatch(/too large/i);
    expect(readFileCalled).toBe(false);
  });

  it('stat failure (e.g. file does not exist) returns 1', async () => {
    const logs: string[] = [];
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve({ server: 'http://localhost:3300', token: 'tok' }) },
      fetchFn: makeStubFetch([
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [baseRelease] } },
      ]),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('x')),
      statFile: () => Promise.reject(new Error('ENOENT')),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'does-not-exist.txt',
    });

    expect(code).toBe(1);
    expect(logs[0]).toMatch(/cannot read file/i);
  });

  it('happy path mapping: POSTs multipart and returns 0', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [baseRelease] } },
          { status: 200, body: { release: baseRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('R0 com.example -> a')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });

    expect(code).toBe(0);
    expect(logs[0]).toBe('Uploaded mapping for 1.0.0+1');
    expect(calls[2]?.url).toBe('http://localhost:3300/api/releases/rel-1/symbols');
    expect(calls[2]?.init.method).toBe('POST');
  });

  it('uses path.basename for the upload filename (Windows-style path)', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [baseRelease] } },
          { status: 200, body: { release: baseRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('R0 com.example -> a')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'C:\\Users\\dev\\build\\mapping.txt',
    });

    expect(code).toBe(0);
    const form = calls[2]?.init.body as FormData;
    const uploaded = form.get('file') as File;
    expect(uploaded.name).toBe('mapping.txt');
  });

  it('happy path sourcemap: includes sourcemap=true in form', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [baseRelease] } },
          { status: 200, body: { release: baseRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'index.android.bundle.map',
    });

    expect(code).toBe(0);
    expect(logs[0]).toBe('Uploaded sourcemap for 1.0.0+1');
    const form = calls[2]?.init.body as FormData;
    expect(form.get('platform')).toBe('android');
    expect(form.get('sourcemap')).toBe('true');
    expect(form.get('bundlePath')).toBeNull();
  });

  it('sourcemap --platform web resolves against the web release row (not android) and sends platform + bundlePath instead of sourcemap=true', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const webRelease = { id: 'rel-web', version: '1.0.0', build: '1', platform: 'web' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          // android release exists too, but must NOT be selected for a web upload
          { status: 200, body: { releases: [baseRelease, webRelease] } },
          { status: 200, body: { release: webRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'chunks/123.js.map',
      platform: 'web',
      bundlePath: 'static/chunks/123.js',
    });

    expect(code).toBe(0);
    expect(calls[2]?.url).toBe('http://localhost:3300/api/releases/rel-web/symbols');
    const form = calls[2]?.init.body as FormData;
    expect(form.get('platform')).toBe('web');
    expect(form.get('bundlePath')).toBe('static/chunks/123.js');
    expect(form.get('sourcemap')).toBeNull();
  });

  it('sourcemap --platform node with no matching release creates it via the upsert (asserting body) and uploads', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const nodeRelease = { id: 'rel-node', version: '1.0.0', build: '1', platform: 'node' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [baseRelease] } }, // android only, no node release
          { status: 201, body: { release: nodeRelease } }, // idempotent upsert creates it
          { status: 200, body: { release: nodeRelease } },
        ],
        calls,
      ),
      log: (line) => logs.push(line),
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: noCommit,
      logs,
    };

    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'server/pages/index.js.map',
      platform: 'node',
      bundlePath: 'server/pages/index.js',
    });

    expect(code).toBe(0);
    // Call 2 is the upsert with the parsed triple; call 3 the actual upload.
    expect(calls[2]?.url).toBe('http://localhost:3300/api/projects/proj-1/releases');
    expect(calls[2]?.init.method).toBe('POST');
    expect(JSON.parse(calls[2]?.init.body as string)).toEqual({
      version: '1.0.0',
      build: '1',
      platform: 'node',
    });
    expect((calls[2]?.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
    expect(logs.some((l) => l === 'Created release 1.0.0+1 for platform node')).toBe(true);
    expect(calls[3]?.url).toBe('http://localhost:3300/api/releases/rel-node/symbols');
    expect(logs.at(-1)).toBe('Uploaded sourcemap for 1.0.0+1');
  });

  it('sourcemap --platform node with --commit passes the flag to resolveCommitSha and includes it on the upsert', async () => {
    const calls: FetchCall[] = [];
    const seenFlagValues: Array<string | undefined> = [];
    const cfg: Config = { server: 'http://localhost:3300', token: 'tok' };
    const nodeRelease = { id: 'rel-node', version: '1.0.0', build: '1', platform: 'node' };
    const deps: UploadDeps & { logs: string[] } = {
      config: { read: () => Promise.resolve(cfg) },
      fetchFn: makeCapturingFetch(
        [
          { status: 200, body: { projects: [baseProject] } },
          { status: 200, body: { releases: [baseRelease] } },
          { status: 201, body: { release: nodeRelease } },
          { status: 200, body: { release: nodeRelease } },
        ],
        calls,
      ),
      log: () => {},
      readFile: () => Promise.resolve(Buffer.from('{"version":3}')),
      statFile: () => Promise.resolve({ size: 1024 }),
      resolveCommitSha: (flagValue) => {
        seenFlagValues.push(flagValue);
        return Promise.resolve('deadbee');
      },
      logs: [],
    };

    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'server/pages/index.js.map',
      platform: 'node',
      bundlePath: 'server/pages/index.js',
      commit: 'DEADBEE',
    });

    expect(code).toBe(0);
    expect(seenFlagValues).toEqual(['DEADBEE']);
    expect(JSON.parse(calls[2]?.init.body as string)).toMatchObject({ commitSha: 'deadbee' });
  });

  it('resolveCommitSha is never invoked for mapping uploads or when the release already exists (no upsert happens)', async () => {
    let called = false;
    const deps = makeDeps(
      { server: 'http://localhost:3300', token: 'tok' },
      [
        { status: 200, body: { projects: [baseProject] } },
        { status: 200, body: { releases: [baseRelease] } },
        { status: 200, body: { release: baseRelease } },
      ],
      {
        resolveCommitSha: () => {
          called = true;
          return Promise.resolve(undefined);
        },
      },
    );
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(0);
    expect(called).toBe(false);
  });

  it('sourcemap --platform node with a failing upsert returns 2', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [baseRelease] } }, // android only, no node release
      { status: 500, body: { error: 'upsert_failed' } },
    ]);
    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'server/pages/index.js.map',
      platform: 'node',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/could not create release/i);
  });

  it('legacy sourcemap (no --platform) does NOT create a release: missing android release still returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [] } },
    ]);
    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'index.android.bundle.map',
    });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/not yet seen by the server/i);
  });

  it('upload server error returns 2', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [baseRelease] } },
      { status: 500, body: { error: 'write_failed' } },
    ]);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/upload failed/i);
  });

  it('401 on the projects call appends a login-refresh hint', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'expired' }, [
      { status: 401, body: { error: 'invalid_or_expired_token' } },
    ]);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/uh-oh login/);
  });

  it('401 on the final upload call appends a login-refresh hint', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'expired' }, [
      { status: 200, body: { projects: [baseProject] } },
      { status: 200, body: { releases: [baseRelease] } },
      { status: 401, body: { error: 'invalid_or_expired_token' } },
    ]);
    const code = await upload(deps, 'mapping', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'mapping.txt',
    });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/upload failed/i);
    expect(deps.logs[0]).toMatch(/uh-oh login/);
  });
});
