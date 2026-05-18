import { describe, it, expect } from 'vitest';
import { apiFetch } from './client.js';

type TokenResponse = { token: string };

const makeJsonFetch =
  (status: number, body: unknown): typeof fetch =>
  (_url, _init) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

const makeNetworkErrorFetch = (): typeof fetch => (_url, _init) =>
  Promise.reject(new Error('network error'));

describe('apiFetch', () => {
  it('sets Authorization header when token provided', async () => {
    let capturedHeaders: RequestInit['headers'] | undefined;
    const stubFetch: typeof fetch = (_url, init) => {
      capturedHeaders = init?.headers;
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'abc' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };

    await apiFetch<TokenResponse>(
      'http://localhost/api/auth/login',
      { method: 'POST', token: 'my-token' },
      stubFetch,
    );

    const hdrs = capturedHeaders as Record<string, string>;
    expect(hdrs['Authorization']).toBe('Bearer my-token');
  });

  it('returns ok:true with parsed data on 200', async () => {
    const result = await apiFetch<TokenResponse>(
      'http://localhost/api/auth/login',
      { method: 'POST' },
      makeJsonFetch(200, { token: 'abc123' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.token).toBe('abc123');
    }
  });

  it('returns auth error on 401', async () => {
    const result = await apiFetch<TokenResponse>(
      'http://localhost/api/projects',
      { method: 'GET', token: 'bad' },
      makeJsonFetch(401, { error: 'invalid_credentials' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('auth');
    }
  });

  it('returns user error on 404', async () => {
    const result = await apiFetch<unknown>(
      'http://localhost/api/projects/missing',
      { method: 'GET', token: 'tok' },
      makeJsonFetch(404, { error: 'not_found' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('user');
    }
  });

  it('returns server error on 500', async () => {
    const result = await apiFetch<unknown>(
      'http://localhost/api/projects',
      { method: 'GET', token: 'tok' },
      makeJsonFetch(500, { error: 'internal' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server');
    }
  });

  it('returns server error on network failure', async () => {
    const result = await apiFetch<unknown>(
      'http://localhost/api/projects',
      { method: 'GET' },
      makeNetworkErrorFetch(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('server');
      expect(result.error.message).toBe('network error');
    }
  });
});
