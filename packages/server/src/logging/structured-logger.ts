// Adapter between the `(message, context)` logger shape and Fastify's pino logger.
//
// The webhook dispatcher, the monitor / spike / fix-verify sweeps, and the
// "alert has nowhere to go" warning (warnNoWebhookTarget, reached from event
// ingest and check-in recovery) log as `logger.error(message, context)`. Pino's
// signature is the other way round, `(context, message)`: when the first
// argument is a string, pino treats every further argument as a printf value
// and silently DROPS an object that no %-placeholder consumes. Pino still
// type-checks against the `(message, context)` shape, so handing `app.log`
// straight to that code compiled and logged every failure as a bare message,
// e.g.
//
//   {"level":50,"msg":"webhook dispatch failed permanently"}
//
// with no dispatch id, status code, error or target: exactly the details an
// operator needs on the day an alert is lost. This adapter flips the order so
// the context lands in the log line as structured fields. Every such call site
// takes `toStructuredLogger(app.log)`: background-jobs.ts, server.ts (ingest)
// and ingest/check-in.ts.

import type { FastifyBaseLogger } from 'fastify';

/** The `(message, context)` logger the dispatcher and the sweeps accept. */
export type StructuredLogger = {
  error: (msg: string, meta?: object) => void;
  warn: (msg: string, meta?: object) => void;
  info: (msg: string, meta?: object) => void;
};

/** Wrap a pino (Fastify) logger so `(message, context)` calls keep the context. */
export const toStructuredLogger = (
  log: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>,
): StructuredLogger => ({
  error: (msg, meta) => {
    log.error(meta ?? {}, msg);
  },
  warn: (msg, meta) => {
    log.warn(meta ?? {}, msg);
  },
  info: (msg, meta) => {
    log.info(meta ?? {}, msg);
  },
});
