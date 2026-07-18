// CONTRACT U-IN — usage analytics ingest. `POST /ingest/:publicKey/usage`
// authenticates with the project public key (like event ingest) and accepts a
// batch of pageview / custom-event records. sendBeacon posts `text/plain`, so
// this route parses BOTH `application/json` and `text/plain` bodies (same JSON).
//
// Privacy is the product: the client IP (request.ip) and User-Agent are read
// ONLY to derive the daily-rotating visitor hash, then discarded. Neither is
// stored on any row, and this handler logs neither. The visitor hash is the sole
// identity artifact and is uncorrelatable across UTC days (the salt rotates).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { getProjectByPublicKey } from '../db/repos/projects.js';
import {
  computeVisitorHash,
  getOrCreateDailySalt,
  insertUsageEvent,
  utcDayString,
} from '../db/repos/usage.js';
import type { Db } from '../db/index.js';
import { metrics } from '../metrics/registry.js';
import type { RateLimiter } from './rate-limit.js';

// Batch cap: more than this and the whole batch is rejected (413). Individual
// invalid events inside a within-cap batch are dropped, not fatal.
const MAX_BATCH = 50;
const MAX_STR = 512;

// Per-event wire schema. A failure here drops just that event (not the batch).
const PropValue = z.union([z.string().max(256), z.number(), z.boolean()]);
const UsageEventSchema = z
  .object({
    type: z.enum(['pageview', 'event']),
    ts: z.number().optional(), // informational; server receivedAt is authoritative
    path: z.string().max(MAX_STR).optional(),
    referrer: z.string().max(MAX_STR).optional(),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
    props: z
      .record(z.string().max(64), PropValue)
      .refine((o) => Object.keys(o).length <= 10, { message: 'at most 10 prop keys' })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'pageview' && (v.path === undefined || v.path === '')) {
      ctx.addIssue({ code: 'custom', message: 'path is required for a pageview' });
    }
    if (v.type === 'event' && v.name === undefined) {
      ctx.addIssue({ code: 'custom', message: 'name is required for an event' });
    }
  });

/** Strip query + fragment from a path (`/a?b#c` -> `/a`). */
const normalizePath = (path: string): string => path.split(/[?#]/, 1)[0] ?? path;

/** First value of a possibly-array header, or undefined. */
const firstHeader = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;

/** Hostname of a URL string, lowercased; null if unparseable. */
const hostOf = (value: string | undefined): string | null => {
  if (value === undefined || value === '') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// The site's own host, taken from the ingest request's Origin (then Referer)
// header — used to null out same-origin referrers. The tracking script posts
// cross-origin to us, so the browser sets Origin to the site's origin.
const siteHostFromRequest = (req: FastifyRequest): string | null =>
  hostOf(firstHeader(req.headers['origin'])) ?? hostOf(firstHeader(req.headers['referer']));

/**
 * Reduce a referrer to its DOMAIN only. Unparseable -> null; same-origin
 * (referrer host === the site's own host) -> null. Storing only the domain (never
 * the full URL, path or query) is the privacy contract.
 */
const referrerToDomain = (referrer: string, siteHost: string | null): string | null => {
  const host = hostOf(referrer);
  if (host === null || host === '') return null;
  if (siteHost !== null && host === siteHost) return null;
  return host;
};

const isBatchBody = (body: unknown): body is { events: unknown[] } =>
  typeof body === 'object' && body !== null && Array.isArray((body as { events?: unknown }).events);

export const registerUsageIngestRoute = (
  app: FastifyInstance,
  db: Db,
  limiter: RateLimiter,
): void => {
  // Encapsulated plugin so the text/plain body parser is scoped to this route
  // only (content-type parsers are otherwise app-wide). The inherited JSON parser
  // still handles application/json bodies.
  void app.register((instance, _opts, done) => {
    instance.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body: string, cb) => {
      if (body.trim() === '') {
        cb(null, undefined);
        return;
      }
      try {
        cb(null, JSON.parse(body));
      } catch {
        // Hand a well-formed "not a batch" value to the handler, which turns it
        // into a clean 400 rather than Fastify's generic parser error.
        cb(null, undefined);
      }
    });

    // CORS preflight for cross-origin fetch (application/json triggers one;
    // sendBeacon with text/plain does not). Mirrors the event-ingest OPTIONS.
    instance.options('/ingest/:publicKey/usage', (_req, reply) =>
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'content-type')
        .header('Access-Control-Max-Age', '86400')
        .code(204)
        .send(),
    );

    instance.post<{ Params: { publicKey: string }; Body: unknown }>(
      '/ingest/:publicKey/usage',
      (req, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');

        const project = getProjectByPublicKey(db, req.params.publicKey);
        if (!project) return reply.code(401).send({ error: 'unknown_public_key' });

        const now = Date.now();
        // Generous per-publicKey bucket — usage is high-volume by design.
        if (!limiter.consume(project.publicKey, now)) {
          return reply.code(429).header('Retry-After', '1').send({ error: 'rate_limit_exceeded' });
        }

        const body = req.body;
        if (!isBatchBody(body)) return reply.code(400).send({ error: 'invalid_body' });
        if (body.events.length > MAX_BATCH) {
          return reply.code(413).send({ error: 'batch_too_large' });
        }

        // Derive the visitor hash once per request (all events in a batch share
        // the same visitor). clientIp + userAgent are used only here.
        const clientIp = req.ip;
        const userAgent = firstHeader(req.headers['user-agent']) ?? '';
        const salt = getOrCreateDailySalt(db, utcDayString(now));
        const visitor = computeVisitorHash({
          salt,
          publicKey: project.publicKey,
          clientIp,
          userAgent,
        });
        const siteHost = siteHostFromRequest(req);

        let accepted = 0;
        let dropped = 0;
        for (const raw of body.events) {
          const parsed = UsageEventSchema.safeParse(raw);
          if (!parsed.success) {
            dropped++;
            continue;
          }
          const e = parsed.data;
          insertUsageEvent(db, {
            projectId: project.id,
            type: e.type,
            name: e.type === 'event' ? (e.name ?? null) : null,
            path: e.type === 'pageview' ? normalizePath(e.path ?? '') : null,
            referrerDomain:
              e.referrer !== undefined ? referrerToDomain(e.referrer, siteHost) : null,
            visitor,
            props: e.props !== undefined ? JSON.stringify(e.props) : null,
            receivedAt: now,
          });
          accepted++;
        }

        if (accepted > 0) metrics.usageEvents.inc(accepted);
        return reply.code(202).send({ accepted, dropped });
      },
    );

    done();
  });
};
