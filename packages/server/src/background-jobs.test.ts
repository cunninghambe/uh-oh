// The wiring index.ts runs at boot: each background job must get a logger whose
// context reaches the emitted line. Before this module existed, index.ts handed
// the jobs Fastify's pino `app.log` directly, and every failure they logged lost
// its id, type, target, error and status code.

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from './db/index.js';
import { captureLog } from './logging/test-utils.js';
import { startBackgroundJobs } from './background-jobs.js';

type JobLogger = {
  error: (msg: string, meta?: object) => void;
  warn?: (msg: string, meta?: object) => void;
  info?: (msg: string, meta?: object) => void;
};
type JobDeps = Record<string, unknown> & { logger?: JobLogger };

// What each job's start function was called with.
const started = vi.hoisted(() => new Map<string, JobDeps>());

vi.mock('./webhooks/dispatcher.js', () => ({
  startDispatcher: (deps: JobDeps) => {
    started.set('dispatcher', deps);
    return { stop: () => Promise.resolve() };
  },
}));
vi.mock('./monitors/sweep.js', () => ({
  startMonitorSweep: (deps: JobDeps) => {
    started.set('monitorSweep', deps);
    return { stop: () => undefined };
  },
}));
vi.mock('./spikes/sweep.js', () => ({
  startSpikeSweep: (deps: JobDeps) => {
    started.set('spikeSweep', deps);
    return { stop: () => undefined };
  },
}));
vi.mock('./fixes/verify-sweep.js', () => ({
  startFixVerifySweep: (deps: JobDeps) => {
    started.set('fixVerifySweep', deps);
    return { stop: () => undefined };
  },
}));

const JOBS = ['dispatcher', 'monitorSweep', 'spikeSweep', 'fixVerifySweep'] as const;
// The jobs are stubbed, so the handle is never queried; identity is all we check.
const db = { sentinel: 'db' } as unknown as Db;
const config = {
  dashboardUrl: 'https://err.example',
  alertLocalTz: 'America/New_York',
  defaultWebhookUrl: 'https://hooks.example/fallback',
  fixVerifyDays: 9,
};

beforeEach(() => {
  started.clear();
});

describe('startBackgroundJobs', () => {
  it('gives every job a logger whose context reaches the log line (real Fastify app.log)', async () => {
    const log = captureLog();
    const app = Fastify({ logger: { stream: log.stream } });
    await app.ready();
    try {
      startBackgroundJobs({ db, log: app.log, ...config });
      for (const job of JOBS) {
        const logger = started.get(job)?.logger;
        expect(logger, job).toBeDefined();
        logger?.error(`${job} failed`, { job, id: 'row-1', statusCode: 404 });
        logger?.warn?.(`${job} warned`, { job, host: 'hooks.example' });
      }
    } finally {
      await app.close();
    }

    for (const job of JOBS) {
      expect(
        log.lines.find((l) => l['msg'] === `${job} failed`),
        job,
      ).toMatchObject({
        level: 50,
        job,
        id: 'row-1',
        statusCode: 404,
      });
      expect(
        log.lines.find((l) => l['msg'] === `${job} warned`),
        job,
      ).toMatchObject({
        level: 40,
        job,
        host: 'hooks.example',
      });
    }
  });

  it('threads the boot configuration to each job', () => {
    const jobs = startBackgroundJobs({ db, log: captureLog().logger, ...config });

    expect(Object.keys(jobs).sort()).toEqual([...JOBS].sort());
    for (const job of JOBS) expect(started.get(job)?.['db'], job).toBe(db);
    expect(started.get('dispatcher')).toMatchObject({
      dashboardUrl: config.dashboardUrl,
      alertLocalTz: config.alertLocalTz,
    });
    expect(started.get('monitorSweep')).toMatchObject({
      defaultWebhookUrl: config.defaultWebhookUrl,
    });
    expect(started.get('spikeSweep')).toMatchObject({
      defaultWebhookUrl: config.defaultWebhookUrl,
    });
    expect(started.get('fixVerifySweep')).toMatchObject({
      defaultWebhookUrl: config.defaultWebhookUrl,
      verifyDays: config.fixVerifyDays,
    });
  });
});
