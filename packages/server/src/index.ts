import { applyMigrations, openDb } from './db/index.js';
import { buildServer } from './server.js';
import { secretFromEnv } from './auth/jwt.js';
import { cleanupExpiredSessions } from './db/repos/sessions.js';
import { pruneOldData, resolveRetentionDays } from './db/repos/retention.js';
import { startDispatcher } from './webhooks/dispatcher.js';

export { applyMigrations, openDb } from './db/index.js';
export { buildServer } from './server.js';
export * as projectsRepo from './db/repos/projects.js';
export * as issuesRepo from './db/repos/issues.js';
export * as eventsRepo from './db/repos/events.js';
export * as breadcrumbsRepo from './db/repos/breadcrumbs.js';
export * from './ingest/ingest.js';
export * from './ingest/fingerprint.js';
export * from './ingest/rate-limit.js';

const isMain = import.meta.url === `file://${process.argv[1] ?? ''}`;

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

  const app = buildServer({ db, logger: true, secret, password, ipRatePerMinute, ipRateBurst });
  app.log.level = logLevel;
  const dispatcherHandle = startDispatcher({ db, logger: app.log, dashboardUrl });

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
