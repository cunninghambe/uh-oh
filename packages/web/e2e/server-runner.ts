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

const app = buildServer({
  db,
  logger: false,
  secret,
  password,
  // v0.9 CONTRACT (SPEC §24 E2E catch-up): server.ts's ipLimiter is a single global per-IP
  // token bucket (default 600/min, burst 100 — see packages/server/src/index.ts's
  // UH_OH_IP_RATE_PER_MIN/UH_OH_IP_RATE_BURST env defaults, sized for one real human browsing
  // session). Every request this whole suite makes — 15 sequential tests, several React-Query
  // GETs per page visit plus every POST — funnels through vite preview's proxy as a single
  // client IP, sharing that one bucket for the entire run. The production default is exhausted
  // partway through a full serial run (observed: a mid-suite check-in POST 429s with
  // rate_limit_exceeded even though its own per-(publicKey,slug) check-in bucket is nowhere near
  // its limit). This is a throwaway e2e server instance, never a real deployment, so generous
  // values here don't weaken anything real — they just stop the test harness's own request
  // volume from tripping a limiter sized for production traffic.
  ipRatePerMinute: 6000,
  ipRateBurst: 1000,
});

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
