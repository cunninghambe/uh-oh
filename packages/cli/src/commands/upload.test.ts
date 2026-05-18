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

const makeDeps = (
  cfg: Config | null,
  fetchResponses: Array<{ status: number; body: unknown }>,
  fileContent?: Buffer,
): UploadDeps & { logs: string[] } => {
  const logs: string[] = [];
  return {
    config: { read: () => Promise.resolve(cfg) },
    fetchFn: makeStubFetch(fetchResponses),
    log: (line) => logs.push(line),
    readFile: () => Promise.resolve(fileContent ?? Buffer.from('fake content')),
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
      logs,
    };

    const code = await upload(deps, 'sourcemap', {
      project: 'my-app',
      release: '1.0.0+1',
      file: 'index.android.bundle.map',
    });

    expect(code).toBe(0);
    expect(logs[0]).toBe('Uploaded sourcemap for 1.0.0+1');
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
});
