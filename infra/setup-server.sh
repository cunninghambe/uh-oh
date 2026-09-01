#!/usr/bin/env bash
set -euo pipefail

# Idempotent setup script for a fresh box.
# Run as root.

# 1. User + directories
id -u uh-oh >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin uh-oh
mkdir -p /opt/uh-oh /var/lib/uh-oh/symbols /var/backups/uh-oh /etc/uh-oh
chown -R uh-oh:uh-oh /var/lib/uh-oh /var/backups/uh-oh

# 2. Node sanity check
command -v node >/dev/null || { echo 'Install Node 22 first'; exit 1; }
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 22+ required, found $(node -v)"; exit 1; }

# 2b. sqlite3 CLI — required by infra/backup.sh (.backup + integrity_check).
# Installed here instead of documented as a manual prerequisite so a fresh
# box doesn't silently fail its first backup run.
command -v sqlite3 >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y sqlite3; }

# 3. Repo must already exist at /opt/uh-oh
[ -d /opt/uh-oh/packages/server ] || { echo 'Place repo at /opt/uh-oh first'; exit 1; }

# 4. Build
# Built as root, not as the `uh-oh` user: /opt/uh-oh is root-owned (deployed
# by whoever placed the repo there) and `uh-oh` is a --no-create-home system
# user with no writable $HOME, so `sudo -u uh-oh pnpm install` fails outright
# (corepack/pnpm need a writable home for their store/cache, and uh-oh can't
# write into /opt/uh-oh anyway). Building as root avoids both problems and
# keeps /opt/uh-oh out of the runtime user's writable surface entirely — the
# hardened systemd unit already limits `uh-oh` to ReadWritePaths=/var/lib/uh-oh,
# and the default umask leaves build output world-readable so the service
# (running as `uh-oh`) can still read and execute it at runtime.
cd /opt/uh-oh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @uh-oh/server build
pnpm --filter @uh-oh/web build

# 5. Env file — must be created by the operator before running this script
if [ ! -f /etc/uh-oh/server.env ]; then
  cat >&2 <<'EOF'
ERROR: /etc/uh-oh/server.env is missing.

Create it with the following variables (see infra/README.md for details):
  UH_OH_ADMIN_PASSWORD=<your admin password>
  UH_OH_JWT_SECRET=<output of: openssl rand -hex 32>
  UH_OH_DASHBOARD_URL=https://errors.example.com

Optional:
  UH_OH_LOG_LEVEL=info
  UH_OH_IP_RATE_PER_MIN=120
  UH_OH_IP_RATE_BURST=20
  UH_OH_RETENTION_DAYS=90
  UH_OH_DEFAULT_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
  UH_OH_ALERT_LOCAL_TZ=America/New_York

Then re-run this script.
EOF
  exit 1
fi
chmod 600 /etc/uh-oh/server.env

# 6. Install and enable systemd units
install -m 644 /opt/uh-oh/infra/uh-oh-server.service  /etc/systemd/system/
install -m 644 /opt/uh-oh/infra/uh-oh-backup.service  /etc/systemd/system/
install -m 644 /opt/uh-oh/infra/uh-oh-backup.timer    /etc/systemd/system/
install -m 644 /opt/uh-oh/infra/uh-oh-alert.service   /etc/systemd/system/
systemctl daemon-reload
# `enable --now` only starts the unit if it isn't already running, so on a
# re-run (the documented upgrade path) it was a no-op that left the OLD
# code running under a freshly-built dist/ on disk. enable + restart is
# correct on both a fresh box (restart on a stopped unit just starts it)
# and an upgrade (restart always picks up the new build).
systemctl enable uh-oh-server.service
systemctl restart uh-oh-server.service
systemctl enable --now uh-oh-backup.timer

# 7. Firewall
bash /opt/uh-oh/infra/ufw.sh

systemctl status uh-oh-server.service --no-pager
echo "---"
echo "Server up. Configure nginx + TLS via subtask 15b."
