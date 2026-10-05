// Test helpers for asserting on what actually reaches the log, as JSON lines,
// rather than on the arguments a logger method was called with. Pino drops a
// trailing context object without complaint, so only the emitted line proves
// the context survived.

import { Writable } from 'node:stream';

import type { FastifyBaseLogger } from 'fastify';
import { pino, type Logger } from 'pino';
import { vi } from 'vitest';

export type LogLine = Record<string, unknown>;

export type CapturedLog = {
  /** Every line written so far, parsed. */
  lines: LogLine[];
  /** The same lines as raw JSON text, for "never contains" checks. */
  raw: string[];
  /** The destination, for `Fastify({ logger: { stream } })`. */
  stream: Writable;
  /** A real pino logger writing into `lines`. */
  logger: Logger;
};

/** A real pino logger whose output is parsed and kept in memory. */
export const captureLog = (): CapturedLog => {
  const lines: LogLine[] = [];
  const raw: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length === 0) continue;
        raw.push(line);
        lines.push(JSON.parse(line) as LogLine);
      }
      cb();
    },
  });
  return { lines, raw, stream, logger: pino(stream) };
};

/**
 * Re-route one level of a logger whose destination a test cannot choose (the
 * `app.log` of a `buildServer()` app) into `into`, passing the arguments through
 * exactly as the code under test made them. Returns the spy; restore it, since
 * Fastify's no-op logger is a process-wide singleton.
 */
export const forwardLevel = (
  log: FastifyBaseLogger,
  level: 'error' | 'warn' | 'info',
  into: Logger,
) =>
  vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
    Reflect.apply(into[level], into, args);
  });
