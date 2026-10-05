// Browser transport for the public ingest surface (`/ingest/*`): CORS and the
// beacon-friendly body parser, shared by event, usage and check-in ingest.
//
// Why CORS echoes the Origin instead of always answering `*`:
// `navigator.sendBeacon` always sends with credentials mode "include". When the
// beacon body is a Blob of a non-safelisted type (the vendored client sends
// `application/json`), Chrome preflights it, and a preflight answered with
// `Access-Control-Allow-Origin: *` FAILS for a credentialed request ("must not be
// the wildcard '*' when the request's credentials mode is 'include'"). The
// browser then never sends the POST. That is exactly what production showed:
// every browser hit on /ingest/<key>/usage was a lone OPTIONS, never a POST.
// Echoing the Origin plus `Access-Control-Allow-Credentials: true` lets those
// beacons through. It is safe here because nothing under /ingest/* authenticates
// with cookies (the project public key in the path is the only credential, and
// it is public by design) and no ingest response carries anything sensitive.
// `/api/*` is untouched: it stays same-origin with no CORS headers at all.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const INGEST_PATH_PREFIX = '/ingest/';

const isIngestUrl = (url: string): boolean => url.startsWith(INGEST_PATH_PREFIX);

// A serialized web origin, exactly as a browser sends it: scheme "://" host
// [":" port]. The host is an ASCII hostname (IDNs arrive as punycode) or a
// bracketed IPv6 literal; no userinfo, path, list or junk port. Anything else
// (the opaque "null" origin, junk) gets the plain wildcard and is never echoed.
const ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[a-z0-9_.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;
const MAX_ORIGIN_LEN = 512;

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;

/** Set the CORS response headers for one /ingest/* request. */
export const applyIngestCors = (req: FastifyRequest, reply: FastifyReply): void => {
  const origin = firstHeader(req.headers['origin']);
  if (origin !== undefined && origin.length <= MAX_ORIGIN_LEN && ORIGIN_RE.test(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Allow-Credentials', 'true');
  } else {
    reply.header('Access-Control-Allow-Origin', '*');
  }
  // The answer depends on the Origin header, so caches must key on it.
  reply.header('Vary', 'Origin');
};

/**
 * Global onRequest hook. Runs before the per-IP limiter, so every /ingest/*
 * response (202s, but also the limiter's 429, a 413 over the body cap, a 400
 * from a bad body) carries CORS headers and the browser can read its status.
 */
export const ingestCorsHook = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  if (isIngestUrl(req.url)) applyIngestCors(req, reply);
};

/**
 * One preflight handler for the whole ingest surface: event ingest, usage, and
 * check-ins. The Allow-Origin/Credentials/Vary headers come from the hook.
 */
export const registerIngestPreflight = (app: FastifyInstance): void => {
  app.options(`${INGEST_PATH_PREFIX}*`, (_req, reply) =>
    reply
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'content-type')
      .header('Access-Control-Max-Age', '86400')
      .code(204)
      .send(),
  );
};

/**
 * `text/plain` body parser that reads the body as JSON. A beacon or fetch sent
 * as text/plain needs no preflight at all, so this is the cheapest browser
 * transport; the route still validates the parsed value. Unparseable or empty
 * text yields `undefined`, which the route turns into its own clean 400.
 * Register it inside an encapsulated plugin so it stays scoped to that route.
 *
 * The JSON itself goes through Fastify's own JSON parser with the app's
 * prototype-poisoning settings (default: reject `__proto__` and
 * `constructor.prototype` keys), so a text/plain body is held to exactly the
 * same rules as the same bytes sent as application/json. A bare JSON.parse
 * would accept those keys and let them reach the route.
 */
export const addTextPlainJsonParser = (instance: FastifyInstance): void => {
  const { onProtoPoisoning = 'error', onConstructorPoisoning = 'error' } = instance.initialConfig;
  // Typed as a callback-or-promise union; Fastify's implementation is the
  // synchronous callback form (fastify/lib/content-type-parser.js).
  const parseJson = instance.getDefaultJsonParser(onProtoPoisoning, onConstructorPoisoning) as (
    req: FastifyRequest,
    body: string,
    done: (err: Error | null, value?: unknown) => void,
  ) => void;
  instance.addContentTypeParser('text/plain', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    parseJson(req, text, (err, value) => {
      done(null, err ? undefined : value);
    });
  });
};
