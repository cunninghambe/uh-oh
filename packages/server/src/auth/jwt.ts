import { SignJWT, jwtVerify } from 'jose';

export type JwtPayload = { sub: 'admin'; jti: string; exp: number; iat: number };

const ALG = 'HS256';
const TTL_SECONDS = 24 * 60 * 60;

export const issueToken = async (
  secret: Uint8Array,
): Promise<{ token: string; jti: string; expiresAt: number }> => {
  const jti = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TTL_SECONDS;
  const token = await new SignJWT({ sub: 'admin' } as { sub: 'admin' })
    .setProtectedHeader({ alg: ALG })
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secret);
  return { token, jti, expiresAt: exp * 1000 };
};

export const verifyToken = async (token: string, secret: Uint8Array): Promise<JwtPayload> => {
  const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] });
  return payload as unknown as JwtPayload;
};

export const secretFromEnv = (): Uint8Array => {
  const raw = process.env['UH_OH_JWT_SECRET'];
  if (!raw || raw.length < 32) {
    throw new Error('UH_OH_JWT_SECRET env var required (min 32 chars)');
  }
  return new TextEncoder().encode(raw);
};
