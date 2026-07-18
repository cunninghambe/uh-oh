import { describe, it, expect } from 'vitest';
import { login } from './login.js';
import type { LoginDeps } from './login.js';
import type { Config } from '../config.js';

const makeConfig = (initial?: Config) => {
  let stored: Config | null = initial ?? null;
  return {
    read: () => Promise.resolve(stored),
    write: (cfg: Config) => {
      stored = cfg;
      return Promise.resolve();
    },
    get stored() {
      return stored;
    },
  };
};

const makeLoginDeps = (
  fetchStatus: number,
  fetchBody: unknown,
  opts?: { configInitial?: Config },
): LoginDeps & { config: ReturnType<typeof makeConfig>; logs: string[] } => {
  const logs: string[] = [];
  const config = makeConfig(opts?.configInitial);
  return {
    prompt: () => Promise.resolve('test-password'),
    config,
    fetchFn: (_url, _init) =>
      Promise.resolve(
        new Response(JSON.stringify(fetchBody), {
          status: fetchStatus,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    log: (line) => logs.push(line),
    logs,
  };
};

describe('login command', () => {
  it('happy path: stores token and returns 0', async () => {
    const deps = makeLoginDeps(200, { token: 'tok_abc' });
    const code = await login(deps, { server: 'http://localhost:3300' });
    expect(code).toBe(0);
    expect(deps.config.stored).toEqual({ server: 'http://localhost:3300', token: 'tok_abc' });
    expect(deps.logs[0]).toBe('Logged in to http://localhost:3300');
  });

  it('wrong password returns 2 and does not store token', async () => {
    const deps = makeLoginDeps(401, { error: 'invalid_credentials' });
    const code = await login(deps, { server: 'http://localhost:3300' });
    expect(code).toBe(2);
    expect(deps.config.stored).toBeNull();
    expect(deps.logs[0]).toBe('Invalid password');
  });

  it('server error returns 2 and does not store token', async () => {
    const deps = makeLoginDeps(500, { error: 'internal_error' });
    const code = await login(deps, { server: 'http://localhost:3300' });
    expect(code).toBe(2);
    expect(deps.config.stored).toBeNull();
  });

  it('strips trailing slashes from --server before persisting and logging', async () => {
    const deps = makeLoginDeps(200, { token: 'tok_abc' });
    const code = await login(deps, { server: 'http://localhost:3300///' });
    expect(code).toBe(0);
    expect(deps.config.stored).toEqual({ server: 'http://localhost:3300', token: 'tok_abc' });
    expect(deps.logs[0]).toBe('Logged in to http://localhost:3300');
  });

  it('network failure returns 2', async () => {
    const logs: string[] = [];
    const config = makeConfig();
    const deps: LoginDeps = {
      prompt: () => Promise.resolve('pw'),
      config,
      fetchFn: () => Promise.reject(new Error('connect refused')),
      log: (line) => logs.push(line),
    };
    const code = await login(deps, { server: 'http://localhost:3300' });
    expect(code).toBe(2);
    expect(config.stored).toBeNull();
  });
});
