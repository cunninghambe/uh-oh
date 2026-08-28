// CONTRACT M — monitor check-in ingest. `POST /ingest/:publicKey/check-in/:slug`
// authenticates with the project public key (like event ingest) and is lightly
// rate-limited per (publicKey, slug). The first ping auto-creates the monitor
// (intervalMinutes required then); later pings bump lastCheckInAt, optionally
// re-set the cadence, and recover a 'missed' monitor (firing monitor.recovered).

import type { FastifyInstance } from 'fastify';

import {
  createMonitor,
  defaultGraceMinutes,
  getMonitorBySlug,
  MONITOR_SLUG_RE,
  recordCheckIn,
} from '../db/repos/monitors.js';
import { getProjectByPublicKey } from '../db/repos/projects.js';
import { enqueueDispatch } from '../db/repos/webhook-dispatches.js';
import { resolveWebhookUrl, warnNoWebhookTarget } from '../webhooks/resolve-url.js';
import type { Db } from '../db/index.js';
import type { RateLimiter } from './rate-limit.js';

// Sane bounds for the check-in cadence: at least 1 minute, at most ~366 days.
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 366 * 24 * 60;

type IntervalParse = { kind: 'absent' } | { kind: 'valid'; value: number } | { kind: 'invalid' };

const parseInterval = (raw: string | undefined): IntervalParse => {
  if (raw === undefined) return { kind: 'absent' };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', value: n };
};

export const registerCheckInRoute = (
  app: FastifyInstance,
  db: Db,
  limiter: RateLimiter,
  /** Instance-level fallback webhook (UH_OH_DEFAULT_WEBHOOK_URL). */
  defaultWebhookUrl?: string,
): void => {
  app.post<{
    Params: { publicKey: string; slug: string };
    Querystring: { intervalMinutes?: string };
  }>('/ingest/:publicKey/check-in/:slug', (req, reply) => {
    const project = getProjectByPublicKey(db, req.params.publicKey);
    if (!project) return reply.code(401).send({ error: 'unknown_public_key' });

    const { slug } = req.params;
    if (!MONITOR_SLUG_RE.test(slug)) {
      return reply.code(400).send({ error: 'invalid_slug' });
    }

    const now = Date.now();
    // Generous, per (publicKey, slug) — a monitor that pings far too often is
    // rate-limited without affecting other monitors or event ingest.
    if (!limiter.consume(`${project.publicKey}::${slug}`, now)) {
      return reply.code(429).header('Retry-After', '60').send({ error: 'rate_limit_exceeded' });
    }

    const interval = parseInterval(req.query.intervalMinutes);
    if (interval.kind === 'invalid') {
      return reply.code(400).send({ error: 'invalid_intervalMinutes' });
    }

    const existing = getMonitorBySlug(db, project.id, slug);
    // §24: an http monitor is driven by server-side probes, not check-in pings.
    // A ping against one is a client error (409), never an auto-created shadow.
    if (existing && existing.kind === 'http') {
      return reply.code(409).send({ error: 'not_a_checkin_monitor' });
    }
    if (!existing) {
      // First ping auto-creates — the cadence must be declared exactly once here.
      if (interval.kind !== 'valid') {
        return reply.code(400).send({ error: 'intervalMinutes_required' });
      }
      const monitor = createMonitor(db, {
        projectId: project.id,
        slug,
        intervalMinutes: interval.value,
        graceMinutes: defaultGraceMinutes(interval.value),
        now,
      });
      return reply.code(202).send({ monitorId: monitor.id });
    }

    const result = recordCheckIn(db, existing.id, {
      now,
      ...(interval.kind === 'valid' ? { intervalMinutes: interval.value } : {}),
    });
    // A recovering monitor (missed -> ok) fires monitor.recovered once.
    if (result?.recovered) {
      const url = resolveWebhookUrl(project, defaultWebhookUrl);
      if (url) {
        enqueueDispatch(db, { monitorId: existing.id, url, type: 'monitor.recovered' }, now);
      } else {
        warnNoWebhookTarget(app.log, project, 'monitor.recovered');
      }
    }
    return reply.code(202).send({ monitorId: existing.id });
  });
};
