# uh-oh — Deployment Operator Manual (s15a)

Covers: systemd service, UFW firewall, daily SQLite backup.
nginx + TLS is covered by subtask 15b.

---

## Prerequisites

- Ubuntu/Debian-based host (tested on Ubuntu 22.04+)
- Node 22+ installed (e.g. via [nvm](https://github.com/nvm-sh/nvm) or NodeSource)
- `sqlite3` CLI installed: `apt-get install -y sqlite3`
- `ufw` installed: `apt-get install -y ufw`
- Repo cloned/deployed to `/opt/uh-oh`

---

## First-time Setup

### 1. Create the env file

Before running `setup-server.sh`, create `/etc/uh-oh/server.env` as root:

```
mkdir -p /etc/uh-oh
cat > /etc/uh-oh/server.env <<EOF
UH_OH_ADMIN_PASSWORD=<your admin password>
UH_OH_JWT_SECRET=$(openssl rand -hex 32)
UH_OH_DASHBOARD_URL=https://errors.example.com
EOF
chmod 600 /etc/uh-oh/server.env
```

### Required environment variables

| Variable               | Required | Description                                                                                |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `UH_OH_ADMIN_PASSWORD` | Yes      | Password for the single admin user. Set to a strong random string.                         |
| `UH_OH_JWT_SECRET`     | Yes      | HS256 signing secret for JWT tokens. Generate with `openssl rand -hex 32`.                 |
| `UH_OH_DASHBOARD_URL`  | Yes      | Public URL of the dashboard (e.g. `https://errors.example.com`). Used in webhook payloads. |

### Optional environment variables

| Variable                | Default | Description                                                         |
| ----------------------- | ------- | ------------------------------------------------------------------- |
| `UH_OH_LOG_LEVEL`       | `info`  | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |
| `UH_OH_IP_RATE_PER_MIN` | `120`   | Per-IP global rate limit — requests allowed per minute window.      |
| `UH_OH_IP_RATE_BURST`   | `20`    | Per-IP burst allowance on top of the per-minute rate.               |

Static env vars set directly in `uh-oh-server.service` (not in `server.env`):

| Variable            | Value                     | Description                                                        |
| ------------------- | ------------------------- | ------------------------------------------------------------------ |
| `UH_OH_DB`          | `/var/lib/uh-oh/uh-oh.db` | SQLite database path.                                              |
| `UH_OH_SYMBOLS_DIR` | `/var/lib/uh-oh/symbols`  | Symbol files directory.                                            |
| `UH_OH_PORT`        | `3300`                    | Fastify listen port (bound to 127.0.0.1 — not exposed externally). |
| `UH_OH_HOST`        | `127.0.0.1`               | Fastify listen address.                                            |

### 2. Run the setup script

```bash
bash /opt/uh-oh/infra/setup-server.sh
```

This script is idempotent — safe to re-run on updates. It:

1. Creates the `uh-oh` system user if not present.
2. Creates `/var/lib/uh-oh/`, `/var/backups/uh-oh/`, `/etc/uh-oh/`.
3. Verifies Node 22+ is available.
4. Installs pnpm dependencies and builds the server + web packages.
5. Verifies `/etc/uh-oh/server.env` exists (exits with instructions if missing).
6. Installs and enables `uh-oh-server.service` and `uh-oh-backup.timer`.
7. Applies UFW firewall rules.

---

## Daily Operations

### Service management

```bash
# Status
systemctl status uh-oh-server

# Restart (e.g. after config change)
systemctl restart uh-oh-server

# Stop / start
systemctl stop uh-oh-server
systemctl start uh-oh-server
```

### Logs

```bash
# Follow live logs
journalctl -u uh-oh-server -f

# Last 100 lines
journalctl -u uh-oh-server -n 100

# Since last boot
journalctl -u uh-oh-server -b
```

Logs are structured JSON (pino). Pipe through `jq` for readability:

```bash
journalctl -u uh-oh-server -f | jq .
```

### Health check

```bash
curl http://127.0.0.1:3300/healthz
# Expected: {"ok":true}
```

From outside the box, port 3300 must be unreachable (UFW blocks it). Use the nginx proxy (port 443) after subtask 15b.

---

## Backups

### How backups work

`uh-oh-backup.timer` fires daily and runs `uh-oh-backup.service`, which calls `infra/backup.sh`.

`backup.sh` uses `sqlite3 .backup` (SQLite's online backup API — safe while the server is running) to write `/var/backups/uh-oh/uh-oh-YYYYMMDD.db`. Files older than 30 days are deleted automatically.

### Check backup status

```bash
# Timer status and next run time
systemctl status uh-oh-backup.timer

# Last backup run
systemctl status uh-oh-backup.service

# List backup files
ls -lh /var/backups/uh-oh/
```

### Run a backup immediately

```bash
systemctl start uh-oh-backup.service
```

### Restore a backup

```bash
# 1. Stop the server
systemctl stop uh-oh-server

# 2. Restore using sqlite3 .restore (replace YYYYMMDD with the target date)
sqlite3 /var/lib/uh-oh/uh-oh.db ".restore '/var/backups/uh-oh/uh-oh-YYYYMMDD.db'"

# 3. Verify the restored DB is readable
sqlite3 /var/lib/uh-oh/uh-oh.db "SELECT count(*) FROM projects;"

# 4. Restart the server
systemctl start uh-oh-server
```

---

## JWT Secret Rotation

Rotating `UH_OH_JWT_SECRET` invalidates all active sessions — all logged-in dashboard users will be signed out immediately.

```bash
# 1. Generate a new secret
NEW_SECRET=$(openssl rand -hex 32)

# 2. Update the env file
# Edit /etc/uh-oh/server.env and replace UH_OH_JWT_SECRET=<old> with the new value.

# 3. Restart the server (picks up new env file)
systemctl restart uh-oh-server
```

---

## Firewall

`ufw.sh` configures UFW with:

- Port 22/tcp open (SSH)
- Port 80/tcp open (HTTP — used by certbot for TLS certificate issuance)
- Port 443/tcp open (HTTPS)
- Port 3300 NOT exposed — nginx proxies to 127.0.0.1:3300

To re-apply after a UFW reset:

```bash
bash /opt/uh-oh/infra/ufw.sh
```

---

## Upgrading the Server

```bash
# 1. Pull latest code to /opt/uh-oh (git pull or re-deploy)
# 2. Re-run the setup script (handles build + unit reinstall)
bash /opt/uh-oh/infra/setup-server.sh
```

---

## systemd-analyze verify

To verify the unit files are syntactically correct on a box with systemd-analyze:

```bash
systemd-analyze verify /opt/uh-oh/infra/uh-oh-server.service
systemd-analyze verify /opt/uh-oh/infra/uh-oh-backup.service
systemd-analyze verify /opt/uh-oh/infra/uh-oh-backup.timer
```

On systems where `systemd-analyze verify` is unavailable (e.g. older distros), review the unit files manually and compare against the templates in this directory.

---

## What's Not Here (subtask 15b)

- nginx vhost configuration
- TLS via Let's Encrypt / certbot
- HTTPS smoke test

Those are documented in `infra/` after subtask 15b ships.
