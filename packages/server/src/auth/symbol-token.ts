// CONTRACT T — scoped symbol-upload token.
//
// When `UH_OH_SYMBOL_TOKEN` is configured, a request carrying the header
// `X-Uh-Oh-Symbol-Token: <token>` (constant-time compared) is authorized
// WITHOUT a JWT, but ONLY on the endpoints the source-map upload flow needs.
// Scope is enforced structurally: {@link buildUploadAuthMiddleware} is attached
// to exactly those upload-flow routes; every other /api/* route keeps the
// JWT-only middleware, so a request bearing only this token is rejected there.
//
// The token value is NEVER logged or echoed — the only thing done with a
// provided header value is a constant-time hash comparison.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { buildAuthMiddleware, type AuthRequest } from './middleware.js';

/** Minimum length for `UH_OH_SYMBOL_TOKEN`. A shorter token fails boot. */
export const MIN_SYMBOL_TOKEN_LENGTH = 16;

/**
 * Header carrying the scoped symbol-upload token. Lower-case because Node/Fastify
 * normalize incoming header names to lower-case.
 */
export const SYMBOL_TOKEN_HEADER = 'x-uh-oh-symbol-token';

/** A request authorized via the symbol token carries this marker instead of a jti. */
type UploadAuthRequest = FastifyRequest & { auth?: { jti: string } | { via: 'symbol-token' } };

/**
 * Parse the optional symbol-upload token from the environment.
 * - unset / empty → `undefined` (feature off)
 * - set but shorter than {@link MIN_SYMBOL_TOKEN_LENGTH} → throws (fail boot)
 */
export const symbolTokenFromEnv = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const raw = env['UH_OH_SYMBOL_TOKEN'];
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < MIN_SYMBOL_TOKEN_LENGTH) {
    throw new Error(
      `UH_OH_SYMBOL_TOKEN must be at least ${String(MIN_SYMBOL_TOKEN_LENGTH)} characters`,
    );
  }
  return raw;
};

/**
 * Constant-time equality independent of input length: hash both sides to a
 * fixed-size digest before comparing (mirrors the login password check). A
 * length mismatch cannot leak via an early return, and the token never appears
 * in any log.
 */
export const symbolTokenMatches = (provided: string, expected: string): boolean => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(sha(provided), sha(expected));
};

/**
 * Auth preHandler for the symbol-upload-flow endpoints ONLY. Authorizes a
 * request that presents a valid `X-Uh-Oh-Symbol-Token` (constant-time compared)
 * WITHOUT requiring a JWT; otherwise it falls back to the standard JWT
 * middleware (which sends its own 401 on failure). When `symbolToken` is
 * undefined the token path is disabled and this is exactly the JWT middleware.
 */
export const buildUploadAuthMiddleware = (deps: {
  db: Db;
  secret: Uint8Array;
  symbolToken?: string | undefined;
  now?: () => number;
}) => {
  const jwtAuth = buildAuthMiddleware({
    db: deps.db,
    secret: deps.secret,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const token = deps.symbolToken;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (token !== undefined) {
      const provided = req.headers[SYMBOL_TOKEN_HEADER];
      if (
        typeof provided === 'string' &&
        provided.length > 0 &&
        symbolTokenMatches(provided, token)
      ) {
        (req as UploadAuthRequest).auth = { via: 'symbol-token' };
        return;
      }
    }
    // No valid token (or feature off) → require a JWT like any other route.
    await jwtAuth(req as AuthRequest, reply);
  };
};
