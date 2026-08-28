#!/usr/bin/env bash
set -euo pipefail

DB=/var/lib/uh-oh/uh-oh.db
SYMBOLS_DIR=/var/lib/uh-oh/symbols
DEST=/var/backups/uh-oh
DATE=$(date +%Y%m%d)
RETENTION_DAYS=30

command -v sqlite3 >/dev/null 2>&1 || {
  echo "ERROR: sqlite3 not found in PATH — install it first (apt-get install -y sqlite3)" >&2
  exit 1
}

mkdir -p "$DEST"

DB_BACKUP="$DEST/uh-oh-$DATE.db"
sqlite3 "$DB" ".backup '$DB_BACKUP'"

# Verify the backup we just took is actually restorable before trusting it —
# a truncated or corrupt .db file here means restores silently fail later,
# possibly not discovered until the day they're needed.
INTEGRITY=$(sqlite3 "$DB_BACKUP" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "ERROR: backup integrity check failed for $DB_BACKUP: $INTEGRITY" >&2
  exit 1
fi

# Symbol files (ProGuard mappings, Hermes source maps) live outside the DB.
# Without this, a restore loses every uploaded symbol file even though
# `releases.mapping_uploaded_at` / `sourcemap_uploaded_at` still claim they
# exist — symbolication silently breaks with no hint in the UI.
if [ -d "$SYMBOLS_DIR" ]; then
  SYMBOLS_BACKUP="$DEST/uh-oh-symbols-$DATE.tar.gz"
  tar -czf "$SYMBOLS_BACKUP" -C "$(dirname "$SYMBOLS_DIR")" "$(basename "$SYMBOLS_DIR")"
else
  echo "WARNING: $SYMBOLS_DIR does not exist, skipping symbols backup" >&2
fi

# Retention: keep 30 days, applied to both the DB and symbols archives.
# -maxdepth 1: retention manages ONLY the dated files this script writes at the
# top level. Without it the glob descended into pre-v09/ (root-owned migration
# safety copies), hit EPERM once those aged past 30 days, and set -e killed the
# job AFTER a good backup but BEFORE its monitor check-in - three missed
# heartbeats (2026-08-25..27) for a backup that was actually succeeding.
find "$DEST" -maxdepth 1 -name 'uh-oh-*.db' -mtime "+$RETENTION_DAYS" -delete
find "$DEST" -maxdepth 1 -name 'uh-oh-symbols-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete

echo "Backup written: $DB_BACKUP (+ symbols archive if present)"
