#!/usr/bin/env bash
set -euo pipefail

# Run shellcheck against all shell scripts in infra/.
# Exits non-zero if any warning or error is found.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

shellcheck "$SCRIPT_DIR/backup.sh" \
           "$SCRIPT_DIR/ufw.sh" \
           "$SCRIPT_DIR/setup-server.sh" \
           "$SCRIPT_DIR/test.sh"

echo "shellcheck: all infra/*.sh clean"
