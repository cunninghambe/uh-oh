// Boots a real @uh-oh/server instance for the e2e suite. Spawned as its own `node --import tsx`
// process by global-setup.ts (cwd set to packages/server so `tsx` resolves from its
// devDependency there) — never imported in-process into the web/Playwright process, since
// @uh-oh/web has no dependency on @uh-oh/server (and this wave's lockfile rule only allows the
// one @playwright/test devDep addition, so it can't gain one).
//
// This deliberately does NOT just spawn packages/server/src/index.ts (its normal CLI entry)
// via `node --import tsx src/index.ts`: that file's `isMain` self-check compares
// `'file://' + process.argv[1]` against `import.meta.url`, and on Windows those never match
// (argv[1] uses backslashes; import.meta.url is always forward-slash `file:///C:/...`), so the
// whole startup block — including app.listen — silently never runs. Driving the same exported
// pieces (openDb/applyMigrations/buildServer) directly here avoids that platform bug entirely,
// without touching anything under packages/server/** (out of this wave's file lane).
import { applyMigrations, openDb } from '../../server/src/db/index.js';
import { buildServer } from '../../server/src/server.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var required`);
  return v;
};

const password = need('UH_OH_ADMIN_PASSWORD');
const secret = new TextEncoder().encode(need('UH_OH_JWT_SECRET'));
const dbPath = need('UH_OH_DB');
const port = Number(process.env['UH_OH_PORT'] ?? 3300);
const host = process.env['UH_OH_HOST'] ?? '127.0.0.1';

const { db, close: closeDb } = openDb(dbPath);
applyMigrations(db);

const app = buildServer({ db, logger: false, secret, password });

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  app
    .close()
    .catch(() => undefined)
    .finally(() => {
      closeDb();
      process.exit(0);
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen({ port, host }).then(
  () => {
    // global-setup.ts's readiness probe polls GET /healthz — this line is only for a human
    // reading CI/local logs.
    console.log(`[e2e-server] listening on http://${host}:${String(port)}`);
  },
  (err: unknown) => {
    console.error('[e2e-server] failed to start:', err);
    process.exit(1);
  },
);
