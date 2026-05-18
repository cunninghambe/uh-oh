export type ApiError =
  | { kind: 'auth'; message: string }
  | { kind: 'user'; message: string }
  | { kind: 'server'; message: string };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const extractMessage = async (res: Response): Promise<string> => {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body['error'] === 'string' ? body['error'] : res.statusText;
  } catch {
    return res.statusText;
  }
};

export const apiFetch = async <T>(
  url: string,
  init: RequestInit & { token?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ApiResult<T>> => {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.token) {
    headers['Authorization'] = `Bearer ${init.token}`;
  }

  let res: Response;
  try {
    res = await fetchFn(url, { ...init, headers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'server', message: msg } };
  }

  if (res.ok) {
    const data = (await res.json()) as T;
    return { ok: true, data };
  }

  const message = await extractMessage(res);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: { kind: 'auth', message } };
  }
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, error: { kind: 'user', message } };
  }
  return { ok: false, error: { kind: 'server', message } };
};
