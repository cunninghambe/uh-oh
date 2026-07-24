// Acceptance (§24): migration 0008 applies cleanly to a v0.8 database (0000–0007)
// carrying real data, adding the release/probe columns and the fingerprint_aliases
// table, and backfilling monitors.kind to 'checkin' / consecutive_failures to 0.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// The v0.8 migration set (everything before this lane's 0008).
const V08_MIGRATIONS = [
  '0000_init',
  '0001_webhook_dispatches',
  '0002_releases_sourcemap',
  '0003_webhook_dispatch_type',
  '0004_issues_platform',
  '0005_monitors_and_dispatch_nullable',
  '0006_usage_analytics',
  '0007_agent_loop',
];

const runMigration = (db: Database.Database, tag: string): void => {
  const sql = fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf8');
  db.exec(sql.replaceAll('--> statement-breakpoint', ''));
};

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

const tableExists = (db: Database.Database, table: string): boolean =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table) !==
  undefined;

describe('migration 0008_release_uptime_merge', () => {
  it('applies to a populated v0.8 database, adding columns/tables and backfilling monitor kind', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const tag of V08_MIGRATIONS) runMigration(db, tag);

      // Seed representative v0.8 data BEFORE 0008 (columns 0008 adds are absent).
      db.prepare(
        `INSERT INTO projects (id, name, slug, public_key, alert_dedupe_minutes, created_at)
         VALUES ('p1', 'App', 'app', 'pk', 30, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, event_count, status)
         VALUES ('i1', 'p1', 'fp', 'TypeError: boom', 1, 2, 3, 'open')`,
      ).run();
      db.prepare(
        `INSERT INTO monitors (id, project_id, slug, interval_minutes, grace_minutes, status, created_at)
         VALUES ('m1', 'p1', 'cron', 10, 5, 'ok', 1)`,
      ).run();
      db.prepare(
        `INSERT INTO usage_events (id, project_id, type, path, visitor, received_at)
         VALUES ('u1', 'p1', 'pageview', '/home', 'abc0123456789def', 5)`,
      ).run();

      // v0.8 schema does NOT have the new columns/tables yet.
      expect(columns(db, 'monitors')).not.toContain('kind');
      expect(columns(db, 'usage_events')).not.toContain('release');
      expect(tableExists(db, 'fingerprint_aliases')).toBe(false);

      runMigration(db, '0008_release_uptime_merge');

      // New columns present.
      expect(columns(db, 'monitors')).toEqual(
        expect.arrayContaining([
          'kind',
          'url',
          'timeout_ms',
          'last_probe_at',
          'last_probe_status',
          'consecutive_failures',
        ]),
      );
      expect(columns(db, 'usage_events')).toContain('release');
      // New table present.
      expect(tableExists(db, 'fingerprint_aliases')).toBe(true);

      // Pre-existing rows survive; new columns backfill to their defaults.
      const issue = db.prepare(`SELECT title FROM issues WHERE id = 'i1'`).get() as {
        title: string;
      };
      expect(issue.title).toBe('TypeError: boom');
      const monitor = db.prepare(`SELECT * FROM monitors WHERE id = 'm1'`).get() as {
        kind: string;
        url: string | null;
        consecutive_failures: number;
        last_probe_at: number | null;
      };
      expect(monitor.kind).toBe('checkin');
      expect(monitor.url).toBeNull();
      expect(monitor.consecutive_failures).toBe(0);
      expect(monitor.last_probe_at).toBeNull();
      const usage = db.prepare(`SELECT release FROM usage_events WHERE id = 'u1'`).get() as {
        release: string | null;
      };
      expect(usage.release).toBeNull();

      // The UNIQUE(project_id, fingerprint) constraint on fingerprint_aliases holds.
      db.prepare(
        `INSERT INTO fingerprint_aliases (project_id, fingerprint, issue_id, created_at)
         VALUES ('p1', 'oldfp', 'i1', 10)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO fingerprint_aliases (project_id, fingerprint, issue_id, created_at)
             VALUES ('p1', 'oldfp', 'i1', 11)`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });
});
