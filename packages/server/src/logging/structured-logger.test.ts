import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { toStructuredLogger } from './structured-logger.js';
import { captureLog } from './test-utils.js';

describe('toStructuredLogger', () => {
  it('exists because raw pino drops a trailing context object', () => {
    const { lines, logger } = captureLog();
    // How index.ts used to wire it: pino is structurally assignable to the jobs'
    // (message, context) logger type, so the compiler never objected.
    const jobLogger: { error: (msg: string, meta?: object) => void } = logger;

    // The exact call shape the dispatcher and the sweeps make.
    jobLogger.error('webhook dispatch failed permanently', { id: 'd1', statusCode: 404 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['msg']).toBe('webhook dispatch failed permanently');
    expect(lines[0]?.['id']).toBeUndefined();
    expect(lines[0]?.['statusCode']).toBeUndefined();
  });

  it('keeps the context as structured fields, at the right level', () => {
    const { lines, logger } = captureLog();
    const log = toStructuredLogger(logger);

    log.error('webhook dispatch failed permanently', { id: 'd1', statusCode: 404 });
    log.warn('webhook dns re-check skipped', { host: 'hooks.example' });
    log.info('sweep ran', { missed: 2 });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      level: 50,
      msg: 'webhook dispatch failed permanently',
      id: 'd1',
      statusCode: 404,
    });
    expect(lines[1]).toMatchObject({
      level: 40,
      msg: 'webhook dns re-check skipped',
      host: 'hooks.example',
    });
    expect(lines[2]).toMatchObject({ level: 30, msg: 'sweep ran', missed: 2 });
  });

  it('logs a bare message when there is no context', () => {
    const { lines, logger } = captureLog();
    toStructuredLogger(logger).warn('UH_OH_DASHBOARD_URL is unset');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, msg: 'UH_OH_DASHBOARD_URL is unset' });
  });

  it('wraps a real Fastify app.log, which is what the server hands the jobs', async () => {
    const { lines, stream } = captureLog();
    const app = Fastify({ logger: { stream } });
    await app.ready();
    try {
      toStructuredLogger(app.log).error('monitor sweep transition failed', {
        id: 'm1',
        error: 'SQLITE_BUSY',
      });
    } finally {
      await app.close();
    }

    const line = lines.find((l) => l['msg'] === 'monitor sweep transition failed');
    expect(line).toMatchObject({ level: 50, id: 'm1', error: 'SQLITE_BUSY' });
  });
});
