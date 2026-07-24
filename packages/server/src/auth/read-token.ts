// CONTRACT R — scoped read token (v0.7 §22).
//
// When `UH_OH_READ_TOKEN` is configured, a request carrying the header
// `X-Uh-Oh-Read-Token: <token>` (constant-time compared) is authorized WITHOUT
// a JWT, but ONLY on the read-only debugging surface an agent session needs.
// Scope is enforced structurally: {@link buildReadAuthMiddleware} is attached to
// exactly the allowlisted read routes; every other /api/* route keeps its
// JWT-only (or upload-token) middleware, so a request bearing only this token is
// rejected there exactly as no auth is.
//
// On `POST /mcp` the same token yields a `readonly` auth scope: read tools run,
// mutating tools return the scope error (see @uh-oh/mcp TOOL_READONLY).
//
// The token value is NEVER logged or echoed — the only thing done with a
// provided header value is a constant-time hash comparison.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { buildAuthMiddleware, type AuthRequest } from './middleware.js';
import { AGENT_TOKEN_HEADER, agentTokenMatches, isAgentTokenAuth } from './agent-token.js';

/** Minimum length for `UH_OH_READ_TOKEN`. A shorter token fails boot. */
export const MIN_READ_TOKEN_LENGTH = 16;

/**
 * Header carrying the scoped read token. Lower-case because Node/Fastify
 * normalize incoming header names to lower-case.
 */
export const READ_TOKEN_HEADER = 'x-uh-oh-read-token';

/** A request authorized via the read token carries this marker instead of a jti. */
export type ReadAuthRequest = FastifyRequest & {
  auth?: { jti: string } | { via: 'read-token' } | { via: 'agent-token' };
};

/** True when the request was authorized via the read token (not a JWT). The
 *  /mcp route reads this to select the `readonly` tool scope. */
export const isReadTokenAuth = (req: FastifyRequest): boolean => {
  const auth = (req as ReadAuthRequest).auth;
  return auth !== undefined && 'via' in auth && auth.via === 'read-token';
};

/** The three tool/request scopes (§22 read, §23 agent, JWT/stdio full). */
export type AuthScope = 'readonly' | 'agent' | 'full';

/**
 * The scope a request was authorized with, for the MCP route to gate tools:
 * `readonly` (read token), `agent` (agent token), or `full` (JWT / stdio). A
 * JWT-authorized request has a jti marker and maps to `full`.
 */
export const requestScope = (req: FastifyRequest): AuthScope => {
  if (isReadTokenAuth(req)) return 'readonly';
  if (isAgentTokenAuth(req)) return 'agent';
  return 'full';
};

/**
 * Parse the optional read token from the environment.
 * - unset / empty → `undefined` (feature off)
 * - set but shorter than {@link MIN_READ_TOKEN_LENGTH} → throws (fail boot)
 */
export const readTokenFromEnv = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const raw = env['UH_OH_READ_TOKEN'];
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < MIN_READ_TOKEN_LENGTH) {
    throw new Error(
      `UH_OH_READ_TOKEN must be at least ${String(MIN_READ_TOKEN_LENGTH)} characters`,
    );
  }
  return raw;
};

/**
 * Constant-time equality independent of input length: hash both sides to a
 * fixed-size digest before comparing (mirrors the symbol-token check). A length
 * mismatch cannot leak via an early return, and the token never appears in any
 * log.
 */
export const readTokenMatches = (provided: string, expected: string): boolean => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(sha(provided), sha(expected));
};

/**
 * Auth preHandler for the allowlisted read-only endpoints. Authorizes a request
 * that presents a valid `X-Uh-Oh-Read-Token` (constant-time compared) WITHOUT
 * requiring a JWT; otherwise it falls back to `fallback` (the standard JWT
 * middleware by default, which sends its own 401 on failure). Routes that also
 * belong to the symbol-upload flow (`GET /api/projects`,
 * `GET /api/projects/:id/releases`) pass the upload middleware as `fallback`, so
 * they accept the read token, the symbol token, OR a JWT. When `readToken` is
 * undefined the token path is disabled and this is exactly `fallback`.
 */
export const buildReadAuthMiddleware = (deps: {
  db: Db;
  secret: Uint8Array;
  readToken?: string | undefined;
  /**
   * Scoped agent token (§23). The agent token authorizes everything the read
   * token authorizes, so read routes accept it too (marking the request `agent`
   * scope). Passing it here is what widens the read allowlist for agents.
   */
  agentToken?: string | undefined;
  fallback?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  now?: () => number;
}) => {
  const jwtAuth = buildAuthMiddleware({
    db: deps.db,
    secret: deps.secret,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const fallback =
    deps.fallback ?? (jwtAuth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>);
  const token = deps.readToken;
  const agentToken = deps.agentToken;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (token !== undefined) {
      const provided = req.headers[READ_TOKEN_HEADER];
      if (
        typeof provided === 'string' &&
        provided.length > 0 &&
        readTokenMatches(provided, token)
      ) {
        (req as ReadAuthRequest).auth = { via: 'read-token' };
        return;
      }
    }
    if (agentToken !== undefined) {
      const provided = req.headers[AGENT_TOKEN_HEADER];
      if (
        typeof provided === 'string' &&
        provided.length > 0 &&
        agentTokenMatches(provided, agentToken)
      ) {
        (req as ReadAuthRequest).auth = { via: 'agent-token' };
        return;
      }
    }
    // No valid read/agent token (or feature off) → defer to the fallback auth.
    await fallback(req as AuthRequest, reply);
  };
};
