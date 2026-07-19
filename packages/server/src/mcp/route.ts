// POST /mcp — a Streamable-HTTP MCP endpoint over the same tool registry the
// stdio bin uses, backed by the InProcessBackend. Stateless mode: a fresh
// McpServer + transport per request (sessionIdGenerator undefined,
// enableJsonResponse true), wired through Fastify's raw req/res. Auth is the
// SAME JWT middleware as /api/* (Authorization: Bearer), plus the scoped read
// token (§22): a read-token request carries a `readonly` tool scope, so the
// mutating tools return the scope error. GET/DELETE → 405, since stateless mode
// only needs POST.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { StreamableHTTPServerTransport, createUhOhMcpServer, type UhOhBackend } from '@uh-oh/mcp';

import { buildReadAuthMiddleware, isReadTokenAuth } from '../auth/read-token.js';
import type { Db } from '../db/index.js';

export const registerMcpRoute = (
  app: FastifyInstance,
  db: Db,
  secret: Uint8Array,
  backend: UhOhBackend,
  readToken?: string,
): void => {
  // JWT OR the read token. A JWT yields the full tool scope; the read token
  // yields `readonly`. When no read token is configured this is exactly the JWT
  // middleware, so the endpoint behaves byte-identically to v0.6.
  const auth = buildReadAuthMiddleware({ db, secret, readToken });
  const preHandler = auth as (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

  app.post<{ Body: unknown }>('/mcp', { preHandler }, async (req, reply) => {
    // Take ownership of the raw response: the transport writes headers + body
    // directly to reply.raw, so Fastify must not also try to send a reply.
    reply.hijack();

    // A read-token request is scoped to read-only tools; a JWT request is full.
    const scope = isReadTokenAuth(req) ? 'readonly' : 'full';
    const server = createUhOhMcpServer(backend, { scope });
    // Stateless mode: OMITTING sessionIdGenerator leaves it `undefined`, which
    // the transport reads as "session management disabled" (a fresh transport
    // per request). This is exactly the `sessionIdGenerator: undefined` the MCP
    // docs prescribe — spelled as omission because exactOptionalPropertyTypes
    // forbids assigning an explicit `undefined` to the SDK's `() => string` key.
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });

    // Stateless: nothing to keep alive between requests. Tear both down when the
    // response socket closes so no per-request McpServer/transport leaks.
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      // `as` cast only to bridge exactOptionalPropertyTypes: the transport class
      // implements Transport, but its onclose/onerror getters are typed
      // `T | undefined`, which trips the strict optional-property check.
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      app.log.error({ err }, 'mcp request handling failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      } else {
        reply.raw.end();
      }
    }
  });

  // Stateless Streamable HTTP only uses POST. Be explicit that the session-based
  // GET (SSE stream) and DELETE (session teardown) verbs are not supported here.
  const methodNotAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed. Use POST for the stateless MCP endpoint.',
        },
        id: null,
      });

  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
};
