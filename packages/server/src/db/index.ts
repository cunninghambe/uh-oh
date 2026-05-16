import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export const openDb = (filePath: string): { db: Db; close: () => void } => {
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
};

export const applyMigrations = (db: Db): void => {
  migrate(db, { migrationsFolder });
};

export * as schema from './schema.js';
