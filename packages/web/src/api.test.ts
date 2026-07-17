import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, setUnauthorizedHandler } from './api.js';
import { getToken, setToken } from './auth.js';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('api 401 handling (H1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it('a 401 from /api/auth/login does not trigger the redirect handler — the error message survives', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: 'invalid credentials' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const err: unknown = await api.login('wrong-password').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect((err as ApiError).message).toBe('invalid credentials');
    expect(handler).not.toHaveBeenCalled();
  });

  it('a 401 from any other endpoint clears the token and calls the redirect handler', async () => {
    setToken('some-old-token');
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const err: unknown = await api.listProjects().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
  });

  it('a non-401 error (e.g. 500) never touches the redirect handler', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const err: unknown = await api.listProjects().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });
});
