import { pathToFileURL } from 'node:url';

import { applyMigrations, openDb } from './db/index.js';
import { buildServer } from './server.js';
import { secretFromEnv } from './auth/jwt.js';
import { symbolTokenFromEnv } from './auth/symbol-token.js';
import { readTokenFromEnv } from './auth/read-token.js';
import { agentTokenFromEnv } from './auth/agent-token.js';
import { cleanupExpiredSessions } from './db/repos/sessions.js';
import { pruneOldData, resolveRetentionDays } from './db/repos/retention.js';
import { startDispatcher } from './webhooks/dispatcher.js';
import { startMonitorSweep } from './monitors/sweep.js';
import { startSpikeSweep } from './spikes/sweep.js';
import { resolveFixVerifyDays, startFixVerifySweep } from './fixes/verify-sweep.js';

export { applyMigrations, openDb } from './db/index.js';
export { buildServer } from './server.js';
export * as projectsRepo from './db/repos/projects.js';
export * as issuesRepo from './db/repos/issues.js';
export * as eventsRepo from './db/repos/events.js';
export * as breadcrumbsRepo from './db/repos/breadcrumbs.js';
export * from './ingest/ingest.js';
export * from './ingest/fingerprint.js';
export * from './ingest/rate-limit.js';

// pathToFileURL handles Windows argv paths (backslashes, drive letters), which
// a naive `file://${argv[1]}` comparison never matches on win32.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const password = process.env['UH_OH_ADMIN_PASSWORD'];
  if (!password || password.length < 8) {
    console.error('UH_OH_ADMIN_PASSWORD env var required (min 8 chars)');
    process.exit(1);
  }

  let secret: Uint8Array;
  try {
    secret = secretFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Optional scoped symbol-upload token (CONTRACT T). Unset = feature off; set
  // but too short = fail boot with a clear error.
  let symbolToken: string | undefined;
  try {
    symbolToken = symbolTokenFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Optional scoped read token (CONTRACT R, §22). Unset = feature off; set but
  // too short = fail boot with a clear error.
  let readToken: string | undefined;
  try {
    readToken = readTokenFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Optional scoped agent token (CONTRACT A, §23). Unset = feature off; set but
  // too short = fail boot with a clear error.
  let agentToken: string | undefined;
  try {
    agentToken = agentTokenFromEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Fix-verification window (§23), days. Unset = default 7; set but invalid =
  // fail boot with a clear error.
  let fixVerifyDays: number;
  try {
    fixVerifyDays = resolveFixVerifyDays(process.env['UH_OH_FIX_VERIFY_DAYS']);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const dbPath = process.env['UH_OH_DB'] ?? './uh-oh.db';
  const port = Number(process.env['UH_OH_PORT'] ?? 3300);
  const host = process.env['UH_OH_HOST'] ?? '0.0.0.0';
  const logLevel = process.env['UH_OH_LOG_LEVEL'] ?? 'info';
  const ipRatePerMinute = Number(process.env['UH_OH_IP_RATE_PER_MIN'] ?? 600);
  const ipRateBurst = Number(process.env['UH_OH_IP_RATE_BURST'] ?? 100);
  const retentionDays = resolveRetentionDays(process.env['UH_OH_RETENTION_DAYS']);
  const dashboardUrl = process.env['UH_OH_DASHBOARD_URL'];

  const { db, close: closeDb } = openDb(dbPath);
  applyMigrations(db);

  const cleanupInterval = setInterval(
    () => {
      cleanupExpiredSessions(db, Date.now());
    },
    60 * 60 * 1000,
  );

  const app = buildServer({
    db,
    logger: true,
    secret,
    password,
    ipRatePerMinute,
    ipRateBurst,
    symbolToken,
    readToken,
    agentToken,
  });
  app.log.level = logLevel;
  const dispatcherHandle = startDispatcher({ db, logger: app.log, dashboardUrl });
  // Dead-man's-switch sweep: flip overdue monitors to 'missed' every 60s.
  const monitorSweepHandle = startMonitorSweep({ db, logger: app.log });
  // Spike sweep (§23): flag issues whose last-hour volume dwarfs baseline every 5m.
  const spikeSweepHandle = startSpikeSweep({ db, logger: app.log });
  // Fix-verification sweep (§23): confirm deployed fixes that held, hourly.
  const fixVerifySweepHandle = startFixVerifySweep({
    db,
    logger: app.log,
    verifyDays: fixVerifyDays,
  });

  const runRetention = () => {
    try {
      const result = pruneOldData(db, { now: Date.now(), retentionDays });
      app.log.info({ ...result, retentionDays }, 'retention prune complete');
    } catch (err) {
      app.log.error({ err }, 'retention prune failed');
    }
  };
  // Run once at boot, then daily.
  runRetention();
  const retentionInterval = setInterval(runRetention, 24 * 60 * 60 * 1000);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Hard cap: if graceful shutdown stalls, force exit.
    const forceTimer = setTimeout(() => {
      console.error('graceful shutdown timed out after 10s; forcing exit');
      process.exit(1);
    }, 10_000);
    try {
      clearInterval(cleanupInterval);
      clearInterval(retentionInterval);
      monitorSweepHandle.stop(); // stop the dead-man's-switch sweep
      spikeSweepHandle.stop(); // stop the spike sweep
      fixVerifySweepHandle.stop(); // stop the fix-verification sweep
      await app.close(); // stop accepting new requests
      await dispatcherHandle.stop(); // drain in-flight webhook dispatches
      closeDb(); // close the SQLite handle
    } catch (err) {
      console.error(err);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  app.listen({ port, host }).then(
    () => {
      app.log.info({ port, host, dbPath }, 'uh-oh server listening');
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
