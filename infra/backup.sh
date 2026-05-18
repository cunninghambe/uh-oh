#!/usr/bin/env bash
set -euo pipefail

DB=/var/lib/uh-oh/uh-oh.db
DEST=/var/backups/uh-oh
DATE=$(date +%Y%m%d)

mkdir -p "$DEST"
sqlite3 "$DB" ".backup '$DEST/uh-oh-$DATE.db'"

# Retention: keep 30 days
find "$DEST" -name 'uh-oh-*.db' -mtime +30 -delete

echo "Backup written: $DEST/uh-oh-$DATE.db"
