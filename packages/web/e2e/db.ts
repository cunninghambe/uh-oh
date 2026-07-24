// Direct-SQLite seeding for the two columns SPEC §24's E2E catch-up guidance calls out as ONLY
// ever written by a background sweep: issues.spike_active/last_spike_at (the 5-minute spike
// sweep, §23) and monitors.last_probe_at/last_probe_status (the uptime probe sweep, §24). Every
// other fixture in this suite goes through a real HTTP call against the booted server (see
// helpers.ts) — this file exists ONLY because waiting on a real sweep timer would make those two
// scenarios slow and flaky, which the brief explicitly says to avoid.
//
// better-sqlite3 is a dependency of @uh-oh/server, not @uh-oh/web, and this wave's lockfile rule
// allows no new devDependency of our own — `createRequire` rooted at the server package resolves
// it through that existing link instead of a fresh install, the same cross-package-boundary trick
// server-runner.ts already uses for its own imports (see that file's top comment).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_DB_PATH_ENV } from './constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRequire = createRequire(path.join(here, '../../server/package.json'));

// Minimal hand-rolled shape for just the three better-sqlite3 methods used below — mirrors how
// helpers.ts hand-rolls the event envelope type instead of importing from @uh-oh/types, so this
// file needs no @types/better-sqlite3 resolution (also server-only) to stay typechecked.
type PreparedStatement = { run: (...params: unknown[]) => unknown };
type SqliteDatabase = {
  pragma: (statement: string) => unknown;
  prepare: (sql: string) => PreparedStatement;
  close: () => void;
};
type SqliteConstructor = new (filename: string) => SqliteDatabase;

const Database = serverRequire('better-sqlite3') as SqliteConstructor;

/** global-setup.ts stashes the booted server's temp DB path here (see constants.ts). */
const resolveDbPath = (): string => {
  const p = process.env[E2E_DB_PATH_ENV];
  if (!p) throw new Error(`${E2E_DB_PATH_ENV} is unset — did global-setup.ts run?`);
  return p;
};

/**
 * Opens a short-lived second connection, runs `fn`, and always closes it — the real server holds
 * its own long-lived WAL connection to the same file (see server-runner.ts -> openDb), so a
 * `busy_timeout` gives this connection a few seconds to wait out any lock contention rather than
 * failing immediately (better-sqlite3's default is a zero-wait `SQLITE_BUSY` throw).
 */
const withDb = <T>(fn: (db: SqliteDatabase) => T): T => {
  const db = new Database(resolveDbPath());
  db.pragma('busy_timeout = 5000');
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

/**
 * Marks an issue as currently spiking (v0.8 §23) — normally set only by the 5-minute spike sweep.
 * Sets exactly the two columns the dashboard reads (api.ts's Issue.spikeActive/lastSpikeAt); the
 * lastHour/baselineHourly stats that drive the *real* sweep's decision aren't needed since the
 * badge only cares about `spikeActive`.
 */
export const seedIssueSpiking = (issueId: string, at: number = Date.now()): void => {
  withDb((db) => {
    db.prepare('UPDATE issues SET spike_active = 1, last_spike_at = ? WHERE id = ?').run(
      at,
      issueId,
    );
  });
};

/**
 * Stamps a monitor's last-probe bookkeeping (v0.9 §24 uptime probes) — normally set only by the
 * probe sweep. `status` is a raw HTTP status (200-399 = success) or `null` to simulate a probe
 * that never got a response (DNS/connect/timeout error) — see MonitorsSection.utils.ts's
 * httpProbeSummary, which is what the dashboard renders this through.
 */
export const seedMonitorProbe = (
  monitorId: string,
  status: number | null,
  at: number = Date.now(),
): void => {
  withDb((db) => {
    db.prepare('UPDATE monitors SET last_probe_at = ?, last_probe_status = ? WHERE id = ?').run(
      at,
      status,
      monitorId,
    );
  });
};
