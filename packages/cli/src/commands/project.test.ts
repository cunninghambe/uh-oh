import { describe, it, expect } from 'vitest';
import { projectList, projectCreate, projectDsn, computeDsn } from './project.js';
import type { ProjectDeps } from './project.js';
import type { Config } from '../config.js';

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

type FetchCall = { url: string; init: RequestInit };

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

const makeDeps = (
  cfg: Config | null,
  fetchResponses: Array<{ status: number; body: unknown }>,
): ProjectDeps & { logs: string[] } => {
  const logs: string[] = [];
  return {
    config: { read: () => Promise.resolve(cfg) },
    fetchFn: makeStubFetch(fetchResponses),
    log: (line) => logs.push(line),
    logs,
  };
};

const projA = {
  id: 'proj-1',
  name: 'My App',
  slug: 'my-app',
  publicKey: 'pk_abc123',
  createdAt: Date.UTC(2026, 0, 15, 12, 0, 0),
};
const projB = {
  id: 'proj-2',
  name: 'Other App',
  slug: 'other-app',
  publicKey: 'pk_def456',
  createdAt: Date.UTC(2026, 1, 1, 0, 0, 0),
};

describe('computeDsn', () => {
  it('preserves the port and mirrors the http scheme', () => {
    expect(computeDsn('http://localhost:3300', 'pk_abc')).toBe('http://pk_abc@localhost:3300');
  });

  it('mirrors the https scheme and omits a port that was never given', () => {
    expect(computeDsn('https://errors.example.com', 'pk_abc')).toBe(
      'https://pk_abc@errors.example.com',
    );
  });

  it('preserves a non-default port on an https server', () => {
    expect(computeDsn('https://errors.example.com:8443', 'pk_abc')).toBe(
      'https://pk_abc@errors.example.com:8443',
    );
  });
});

describe('project list', () => {
  it('missing config returns 2', async () => {
    const deps = makeDeps(null, []);
    const code = await projectList(deps);
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('config without token returns 2', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300' }, []);
    const code = await projectList(deps);
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('401 appends a login-refresh hint', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'expired' }, [
      { status: 401, body: { error: 'invalid_or_expired_token' } },
    ]);
    const code = await projectList(deps);
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/uh-oh login/);
  });

  it('no projects prints a friendly message', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [] } },
    ]);
    const code = await projectList(deps);
    expect(code).toBe(0);
    expect(deps.logs[0]).toMatch(/no projects found/i);
  });

  it('prints a table with name, slug, publicKey, created columns', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [projA, projB] } },
    ]);
    const code = await projectList(deps);
    expect(code).toBe(0);
    expect(deps.logs[0]).toMatch(/^name\s+slug\s+publicKey\s+created$/);
    expect(deps.logs[1]).toContain('My App');
    expect(deps.logs[1]).toContain('my-app');
    expect(deps.logs[1]).toContain('pk_abc123');
    expect(deps.logs[1]).toContain(new Date(projA.createdAt).toISOString());
    expect(deps.logs[2]).toContain('Other App');
    expect(deps.logs).toHaveLength(3);
  });
});

describe('project create', () => {
  it('missing config returns 2', async () => {
    const deps = makeDeps(null, []);
    const code = await projectCreate(deps, { name: 'New App' });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('server error returns 2', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 400, body: { error: 'invalid_name' } },
    ]);
    const code = await projectCreate(deps, { name: '' });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/error creating project/i);
  });

  it('401 appends a login-refresh hint', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'expired' }, [
      { status: 401, body: { error: 'invalid_or_expired_token' } },
    ]);
    const code = await projectCreate(deps, { name: 'New App' });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/uh-oh login/);
  });

  it('happy path: POSTs the name and prints the slug + DSN', async () => {
    const calls: FetchCall[] = [];
    const logs: string[] = [];
    const deps: ProjectDeps & { logs: string[] } = {
      config: {
        read: () => Promise.resolve({ server: 'http://localhost:3300', token: 'tok' }),
      },
      fetchFn: makeCapturingFetch([{ status: 201, body: { project: projA } }], calls),
      log: (line) => logs.push(line),
      logs,
    };

    const code = await projectCreate(deps, { name: 'My App' });

    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('http://localhost:3300/api/projects');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ name: 'My App' });
    expect(logs[0]).toBe('Created project my-app');
    expect(logs[1]).toBe('DSN: http://pk_abc123@localhost:3300');
  });
});

describe('project dsn', () => {
  it('missing config returns 2', async () => {
    const deps = makeDeps(null, []);
    const code = await projectDsn(deps, { slug: 'my-app' });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/not logged in/i);
  });

  it('project not found returns 1', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [projA] } },
    ]);
    const code = await projectDsn(deps, { slug: 'missing-app' });
    expect(code).toBe(1);
    expect(deps.logs[0]).toMatch(/missing-app not found/i);
  });

  it('401 appends a login-refresh hint', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'expired' }, [
      { status: 401, body: { error: 'invalid_or_expired_token' } },
    ]);
    const code = await projectDsn(deps, { slug: 'my-app' });
    expect(code).toBe(2);
    expect(deps.logs[0]).toMatch(/uh-oh login/);
  });

  it('happy path: prints the DSN and both consumer env lines', async () => {
    const deps = makeDeps({ server: 'https://errors.example.com', token: 'tok' }, [
      { status: 200, body: { projects: [projA] } },
    ]);
    const code = await projectDsn(deps, { slug: 'my-app' });
    expect(code).toBe(0);
    expect(deps.logs[0]).toBe('https://pk_abc123@errors.example.com');
    expect(deps.logs[1]).toBe('UH_OH_DSN=https://pk_abc123@errors.example.com');
    expect(deps.logs[2]).toBe('NEXT_PUBLIC_UH_OH_DSN=https://pk_abc123@errors.example.com');
  });

  it('DSN scheme follows the stored server scheme, not always https', async () => {
    const deps = makeDeps({ server: 'http://localhost:3300', token: 'tok' }, [
      { status: 200, body: { projects: [projA] } },
    ]);
    const code = await projectDsn(deps, { slug: 'my-app' });
    expect(code).toBe(0);
    expect(deps.logs[0]).toBe('http://pk_abc123@localhost:3300');
  });
});
