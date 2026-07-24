// CONTRACT A — scoped agent token (v0.8 §23). The third scoped token, after the
// symbol-upload token (§19) and the read token (§22).
//
// When `UH_OH_AGENT_TOKEN` is configured, a request carrying the header
// `X-Uh-Oh-Agent-Token: <token>` (constant-time compared) is authorized WITHOUT
// a JWT. Its scope is the read token's read-only surface PLUS exactly four
// writes: PATCH /api/issues/:id, POST /api/issues/:id/annotations,
// POST /api/issues/:id/fix-attempts, PATCH /api/fix-attempts/:id. The read
// allowlist accepts it via `buildReadAuthMiddleware`; the four writes accept it
// via {@link buildAgentAuthMiddleware}. Every other route keeps its JWT-only (or
// upload-token) middleware, so a request bearing only this token is rejected
// there exactly as no auth is.
//
// On `POST /mcp` the same token yields an `agent` tool scope (wired by the MCP
// route). The token value is NEVER logged or echoed — the only thing done with a
// provided header value is a constant-time hash comparison.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Db } from '../db/index.js';
import { buildAuthMiddleware, type AuthRequest } from './middleware.js';

/** Minimum length for `UH_OH_AGENT_TOKEN`. A shorter token fails boot. */
export const MIN_AGENT_TOKEN_LENGTH = 16;

/**
 * Header carrying the scoped agent token. Lower-case because Node/Fastify
 * normalize incoming header names to lower-case.
 */
export const AGENT_TOKEN_HEADER = 'x-uh-oh-agent-token';

/** A request authorized via the agent token carries this marker instead of a jti. */
export type AgentAuthRequest = FastifyRequest & {
  auth?: { jti: string } | { via: 'read-token' } | { via: 'agent-token' };
};

/** True when the request was authorized via the agent token (not a JWT/read token). */
export const isAgentTokenAuth = (req: FastifyRequest): boolean => {
  const auth = (req as AgentAuthRequest).auth;
  return auth !== undefined && 'via' in auth && auth.via === 'agent-token';
};

/**
 * Parse the optional agent token from the environment.
 * - unset / empty → `undefined` (feature off)
 * - set but shorter than {@link MIN_AGENT_TOKEN_LENGTH} → throws (fail boot)
 */
export const agentTokenFromEnv = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const raw = env['UH_OH_AGENT_TOKEN'];
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < MIN_AGENT_TOKEN_LENGTH) {
    throw new Error(
      `UH_OH_AGENT_TOKEN must be at least ${String(MIN_AGENT_TOKEN_LENGTH)} characters`,
    );
  }
  return raw;
};

/**
 * Constant-time equality independent of input length: hash both sides to a
 * fixed-size digest before comparing (mirrors the read/symbol token checks). A
 * length mismatch cannot leak via an early return, and the token never appears
 * in any log.
 */
export const agentTokenMatches = (provided: string, expected: string): boolean => {
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(sha(provided), sha(expected));
};

/**
 * Auth preHandler for the agent-writable endpoints (the four §23 writes).
 * Authorizes a request presenting a valid `X-Uh-Oh-Agent-Token` (constant-time
 * compared) WITHOUT a JWT; otherwise it falls back to `fallback` (the standard
 * JWT middleware by default, which sends its own 401). A read token does NOT
 * match here, so it falls through to the JWT check and is rejected — exactly the
 * scope boundary §23 requires. When `agentToken` is undefined the token path is
 * disabled and this is exactly `fallback`.
 */
export const buildAgentAuthMiddleware = (deps: {
  db: Db;
  secret: Uint8Array;
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
  const token = deps.agentToken;

  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (token !== undefined) {
      const provided = req.headers[AGENT_TOKEN_HEADER];
      if (
        typeof provided === 'string' &&
        provided.length > 0 &&
        agentTokenMatches(provided, token)
      ) {
        (req as AgentAuthRequest).auth = { via: 'agent-token' };
        return;
      }
    }
    await fallback(req as AuthRequest, reply);
  };
};
