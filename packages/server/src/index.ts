import { applyMigrations, openDb } from './db/index.js';
import { buildServer } from './server.js';

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
  const dbPath = process.env['UH_OH_DB'] ?? './uh-oh.db';
  const port = Number(process.env['UH_OH_PORT'] ?? 3300);
  const host = process.env['UH_OH_HOST'] ?? '0.0.0.0';

  const { db } = openDb(dbPath);
  applyMigrations(db);

  const app = buildServer({ db, logger: true });
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
