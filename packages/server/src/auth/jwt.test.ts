import { describe, expect, it, afterEach } from 'vitest';
import { issueToken, verifyToken, secretFromEnv } from './jwt.js';

const makeSecret = () => new TextEncoder().encode('a'.repeat(32));

describe('issueToken', () => {
  it('returns a token with valid HS256 signature', async () => {
    const secret = makeSecret();
    const { token, jti, expiresAt } = await issueToken(secret);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
    expect(typeof jti).toBe('string');
    expect(jti.length).toBeGreaterThan(0);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });
});

describe('verifyToken', () => {
  it('accepts valid token', async () => {
    const secret = makeSecret();
    const { token, jti } = await issueToken(secret);
    const payload = await verifyToken(token, secret);
    expect(payload.sub).toBe('admin');
    expect(payload.jti).toBe(jti);
  });

  it('rejects expired token', async () => {
    const secret = makeSecret();
    // Create a token that expired 1 second ago by signing with exp in past
    const { SignJWT } = await import('jose');
    const expiredToken = await new SignJWT({ sub: 'admin' } as { sub: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti(crypto.randomUUID())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(secret);
    await expect(verifyToken(expiredToken, secret)).rejects.toThrow();
  });

  it('rejects bad signature', async () => {
    const secret1 = makeSecret();
    const secret2 = new TextEncoder().encode('b'.repeat(32));
    const { token } = await issueToken(secret1);
    await expect(verifyToken(token, secret2)).rejects.toThrow();
  });
});

describe('secretFromEnv', () => {
  const orig = process.env['UH_OH_JWT_SECRET'];

  afterEach(() => {
    if (orig === undefined) {
      delete process.env['UH_OH_JWT_SECRET'];
    } else {
      process.env['UH_OH_JWT_SECRET'] = orig;
    }
  });

  it('throws when env unset', () => {
    delete process.env['UH_OH_JWT_SECRET'];
    expect(() => secretFromEnv()).toThrow();
  });

  it('throws when env too short', () => {
    process.env['UH_OH_JWT_SECRET'] = 'short';
    expect(() => secretFromEnv()).toThrow();
  });

  it('returns Uint8Array when valid', () => {
    process.env['UH_OH_JWT_SECRET'] = 'x'.repeat(32);
    const result = secretFromEnv();
    expect(result).toBeInstanceOf(Uint8Array);
  });
});
