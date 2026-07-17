import { beforeEach, describe, expect, it } from 'vitest';

import { getTokenExpiryMs, isAuthed, minutesUntilExpiry, setToken } from './auth.js';

const base64UrlEncode = (obj: unknown): string => {
  const base64 = btoa(JSON.stringify(obj));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const makeJwt = (payload: Record<string, unknown>): string =>
  `${base64UrlEncode({ alg: 'HS256', typ: 'JWT' })}.${base64UrlEncode(payload)}.fake-signature`;

describe('isAuthed', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is false with no token stored', () => {
    expect(isAuthed()).toBe(false);
  });

  it('is true for a token whose exp is in the future (M8)', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 60 * 60; // +1h
    setToken(makeJwt({ exp: futureExp }));
    expect(isAuthed()).toBe(true);
  });

  it('is false for a token whose exp is in the past — the 24h-expiry case (M8)', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60; // -1min
    setToken(makeJwt({ exp: pastExp }));
    expect(isAuthed()).toBe(false);
  });

  it('is false for a malformed token instead of throwing', () => {
    setToken('not-a-real-jwt');
    expect(isAuthed()).toBe(false);
  });

  it('is false for a token with no exp claim', () => {
    setToken(makeJwt({ sub: 'admin' }));
    expect(isAuthed()).toBe(false);
  });
});

describe('getTokenExpiryMs / minutesUntilExpiry', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when there is no token', () => {
    expect(getTokenExpiryMs()).toBeNull();
    expect(minutesUntilExpiry()).toBeNull();
  });

  it('decodes exp (seconds) to milliseconds and reports minutes remaining', () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 90 * 60; // +90min
    setToken(makeJwt({ exp: expSeconds }));
    expect(getTokenExpiryMs()).toBe(expSeconds * 1000);
    const minutes = minutesUntilExpiry();
    expect(minutes).not.toBeNull();
    expect(minutes ?? 0).toBeGreaterThan(89);
    expect(minutes ?? 0).toBeLessThanOrEqual(90);
  });
});
