// The four background jobs the server runs beside its HTTP routes: the webhook
// dispatcher and the monitor, spike and fix-verification sweeps.
//
// Started here rather than inline in index.ts so the wiring has a test
// (background-jobs.test.ts). Every job logs as `logger.error(message, context)`,
// while Fastify's `app.log` is pino, which reads `(context, message)` and
// silently drops a context object passed after the message. Handing the jobs
// `app.log` raw therefore compiled cleanly and logged every failure as a bare
// message. The jobs only ever receive `toStructuredLogger(log)`.

import type { FastifyBaseLogger } from 'fastify';

import type { Db } from './db/index.js';
import { toStructuredLogger } from './logging/structured-logger.js';
import { startDispatcher, type DispatcherHandle } from './webhooks/dispatcher.js';
import { startMonitorSweep, type MonitorSweepHandle } from './monitors/sweep.js';
import { startSpikeSweep, type SpikeSweepHandle } from './spikes/sweep.js';
import { startFixVerifySweep, type FixVerifySweepHandle } from './fixes/verify-sweep.js';

export type BackgroundJobsDeps = {
  db: Db;
  /** Fastify's `app.log`. Wrapped here; never handed to a job raw. */
  log: Pick<FastifyBaseLogger, 'error' | 'warn' | 'info'>;
  /** `UH_OH_DASHBOARD_URL`, for links in alert payloads. */
  dashboardUrl: string | undefined;
  /** `UH_OH_ALERT_LOCAL_TZ`, validated at boot. */
  alertLocalTz: string;
  /** `UH_OH_DEFAULT_WEBHOOK_URL`, validated at boot. */
  defaultWebhookUrl: string | undefined;
  /** `UH_OH_FIX_VERIFY_DAYS`, validated at boot. */
  fixVerifyDays: number;
};

export type BackgroundJobs = {
  dispatcher: DispatcherHandle;
  monitorSweep: MonitorSweepHandle;
  spikeSweep: SpikeSweepHandle;
  fixVerifySweep: FixVerifySweepHandle;
};

export const startBackgroundJobs = (deps: BackgroundJobsDeps): BackgroundJobs => {
  const { db, dashboardUrl, alertLocalTz, defaultWebhookUrl } = deps;
  const logger = toStructuredLogger(deps.log);
  return {
    dispatcher: startDispatcher({ db, logger, dashboardUrl, alertLocalTz }),
    // Dead-man's-switch sweep: flip overdue monitors to 'missed' every 60s.
    monitorSweep: startMonitorSweep({ db, logger, defaultWebhookUrl }),
    // Spike sweep (§23): flag issues whose last-hour volume dwarfs baseline every 5m.
    spikeSweep: startSpikeSweep({ db, logger, defaultWebhookUrl }),
    // Fix-verification sweep (§23): confirm deployed fixes that held, hourly.
    fixVerifySweep: startFixVerifySweep({
      db,
      logger,
      verifyDays: deps.fixVerifyDays,
      defaultWebhookUrl,
    }),
  };
};
