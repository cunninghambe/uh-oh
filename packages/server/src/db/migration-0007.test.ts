// Acceptance (§23): migration 0007 applies cleanly to a v0.7 database (0000–0006)
// carrying real data, adding the new columns/tables and defaulting spike_active.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

// The v0.7 migration set (everything before this lane's 0007).
const V07_MIGRATIONS = [
  '0000_init',
  '0001_webhook_dispatches',
  '0002_releases_sourcemap',
  '0003_webhook_dispatch_type',
  '0004_issues_platform',
  '0005_monitors_and_dispatch_nullable',
  '0006_usage_analytics',
];

const runMigration = (db: Database.Database, tag: string): void => {
  const sql = fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf8');
  // The migrator executes statements split on this marker; a plain exec of the
  // whole script with the markers stripped is equivalent for a fresh DB.
  db.exec(sql.replaceAll('--> statement-breakpoint', ''));
};

const columns = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

const tableExists = (db: Database.Database, table: string): boolean =>
  db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(table) !==
  undefined;

describe('migration 0007_agent_loop', () => {
  it('applies to a populated v0.7 database, adding columns/tables and defaulting spike_active', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      for (const tag of V07_MIGRATIONS) runMigration(db, tag);

      // Seed representative v0.7 data BEFORE 0007 (columns 0007 adds are absent).
      db.prepare(
        `INSERT INTO projects (id, name, slug, public_key, alert_dedupe_minutes, created_at)
         VALUES ('p1', 'App', 'app', 'pk', 30, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, event_count, status)
         VALUES ('i1', 'p1', 'fp', 'TypeError: boom', 1, 2, 3, 'open')`,
      ).run();
      db.prepare(
        `INSERT INTO releases (id, project_id, version, build, platform)
         VALUES ('r1', 'p1', '1.0.0', '1', 'android')`,
      ).run();

      // v0.7 schema does NOT have the new columns/tables yet.
      expect(columns(db, 'issues')).not.toContain('spike_active');
      expect(tableExists(db, 'fix_attempts')).toBe(false);

      runMigration(db, '0007_agent_loop');

      // New columns present.
      expect(columns(db, 'projects')).toContain('repo_url');
      expect(columns(db, 'releases')).toContain('commit_sha');
      expect(columns(db, 'issues')).toEqual(
        expect.arrayContaining(['spike_active', 'last_spike_at']),
      );
      // New tables present.
      expect(tableExists(db, 'issue_annotations')).toBe(true);
      expect(tableExists(db, 'fix_attempts')).toBe(true);

      // Pre-existing rows survive; spike_active backfills to 0, new nullables null.
      const issue = db.prepare(`SELECT * FROM issues WHERE id = 'i1'`).get() as {
        title: string;
        spike_active: number;
        last_spike_at: number | null;
        event_count: number;
      };
      expect(issue.title).toBe('TypeError: boom');
      expect(issue.event_count).toBe(3);
      expect(issue.spike_active).toBe(0);
      expect(issue.last_spike_at).toBeNull();

      const project = db.prepare(`SELECT repo_url FROM projects WHERE id = 'p1'`).get() as {
        repo_url: string | null;
      };
      expect(project.repo_url).toBeNull();

      // The UNIQUE(issue_id, pr_url) constraint on fix_attempts is enforceable.
      db.prepare(
        `INSERT INTO fix_attempts (id, issue_id, pr_url, state, created_at, updated_at)
         VALUES ('fa1', 'i1', 'https://gh/pr/1', 'filed', 10, 10)`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO fix_attempts (id, issue_id, pr_url, state, created_at, updated_at)
             VALUES ('fa2', 'i1', 'https://gh/pr/1', 'filed', 11, 11)`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });
});
