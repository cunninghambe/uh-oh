const KEY = 'uh-oh.token';

export const getToken = (): string | null => localStorage.getItem(KEY);

export const setToken = (t: string | null): void => {
  if (t === null) {
    localStorage.removeItem(KEY);
  } else {
    localStorage.setItem(KEY, t);
  }
};

type JwtPayload = { exp?: number; [key: string]: unknown };

/**
 * Decode a JWT payload client-side (no verification — this is a UX check only,
 * not a security boundary; the server is the source of truth for validity).
 * Plain base64url decode, no library.
 */
export const decodeJwtPayload = (token: string): JwtPayload | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const encoded = parts[1];
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as JwtPayload) : null;
  } catch {
    return null;
  }
};

/** Token expiry as epoch ms, or null if there's no token or it can't be decoded. */
export const getTokenExpiryMs = (): number | null => {
  const token = getToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number') return null;
  return payload.exp * 1000; // JWT `exp` is seconds since epoch
};

/** Minutes remaining before expiry, or null if unknown/no token. Negative once expired. */
export const minutesUntilExpiry = (): number | null => {
  const expiryMs = getTokenExpiryMs();
  if (expiryMs === null) return null;
  return (expiryMs - Date.now()) / 60_000;
};

// Treat a token we can't decode, or one with no exp we can verify, as unauthenticated —
// proactive expiry checking is the whole point here (see SPEC §5: 24h JWT expiry).
export const isAuthed = (): boolean => {
  const expiryMs = getTokenExpiryMs();
  if (expiryMs === null) return false;
  return expiryMs > Date.now();
};
