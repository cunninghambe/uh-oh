# uh-oh — Deployment Operator Manual (s15a)

Covers: systemd service, UFW firewall, daily SQLite backup.
nginx + TLS is covered by subtask 15b.

---

## Prerequisites

- Ubuntu/Debian-based host (tested on Ubuntu 22.04+)
- Node 22+ installed (e.g. via [nvm](https://github.com/nvm-sh/nvm) or NodeSource)
- `ufw` installed: `apt-get install -y ufw`
- Repo cloned/deployed to `/opt/uh-oh`

`sqlite3` is installed automatically by `setup-server.sh` if missing (it's required by `backup.sh`) — no manual step needed.

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

| Variable                    | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UH_OH_LOG_LEVEL`           | `info`  | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `UH_OH_IP_RATE_PER_MIN`     | `120`   | Per-IP global rate limit — requests allowed per minute window.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `UH_OH_IP_RATE_BURST`       | `20`    | Per-IP burst allowance on top of the per-minute rate.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `UH_OH_RETENTION_DAYS`      | `90`    | How long event/issue data is retained before pruning. See the commented example in `uh-oh-server.service`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `UH_OH_READ_TOKEN`          | _unset_ | Scoped read token (§22, min 16 chars — a shorter value fails boot). When set, requests bearing `X-Uh-Oh-Read-Token` reach the read-only API surface and a read-only `POST /mcp` tool scope without a JWT. Generate with `openssl rand -hex 24`. Unset = feature off.                                                                                                                                                                                                                               |
| `UH_OH_DEFAULT_WEBHOOK_URL` | _unset_ | Instance-level fallback webhook. Any alert (`monitor.missed`, `monitor.recovered`, `issue.new`, `issue.regressed`, `issue.spike`, `fix.verified`) for a project with no `webhook_url` of its own is delivered here instead of being dropped. A Discord webhook URL (`https://discord.com/api/webhooks/…`) receives a one-line chat message; every other URL receives the standard JSON payload. An invalid value is logged at error and ignored — the server still boots, it just has no fallback. |

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
3. Verifies Node 22+ is available, and installs `sqlite3` if missing.
4. Installs pnpm dependencies and builds the server + web packages (as root — see comment in the script; `uh-oh` has no writable home directory and isn't given write access to `/opt/uh-oh`).
5. Verifies `/etc/uh-oh/server.env` exists (exits with instructions if missing).
6. Installs `uh-oh-server.service`, `uh-oh-backup.service`, `uh-oh-backup.timer`, and `uh-oh-alert.service`; enables and (re)starts the server unconditionally, so re-running this script after a code update actually serves the new build.
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

### Bounding journald disk usage

By default journald's disk usage is capped as a fraction of the filesystem it lives on, which on a small VPS can still be large enough to matter, especially if request logging is verbose (`UH_OH_LOG_LEVEL=debug`) or the box is under sustained crash-storm traffic. Set an explicit cap in `/etc/systemd/journald.conf`:

```ini
[Journal]
SystemMaxUse=1G
```

Then apply it:

```bash
systemctl restart systemd-journald
```

This is a one-time manual step (not automated by `setup-server.sh`) — journald is a system-wide service shared by every unit on the box, not something specific to uh-oh, so it's out of scope for a per-app setup script to reconfigure unilaterally.

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

`backup.sh` uses `sqlite3 .backup` (SQLite's online backup API — safe while the server is running) to write `/var/backups/uh-oh/uh-oh-YYYYMMDD.db`, then runs `PRAGMA integrity_check` against that copy and fails the unit (triggering the alert below) if it doesn't come back `ok` — a bad backup fails loudly instead of sitting unnoticed until the day you actually need it.

The `symbols/` directory (ProGuard mappings, Hermes source maps) is archived alongside the DB into `/var/backups/uh-oh/uh-oh-symbols-YYYYMMDD.tar.gz`. Restoring the DB without also restoring this archive leaves `releases.mapping_uploaded_at` / `sourcemap_uploaded_at` pointing at symbol files that no longer exist — symbolication breaks with no hint in the UI.

Both the `.db` and `.tar.gz` files older than 30 days are deleted automatically.

### Backup failure alerts

If `backup.sh` exits non-zero (missing `sqlite3`, failed integrity check, etc.), `uh-oh-backup.service`'s `OnFailure=` fires `uh-oh-alert.service`, which logs an `err`-level line to the journal (tag `uh-oh-alert`) and `wall`s all logged-in terminals. The same alert unit is wired to `uh-oh-server.service`. Check recent failures with:

```bash
journalctl -t uh-oh-alert -n 20
systemctl --failed
```

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

# 2. Restore the DB using sqlite3 .restore (replace YYYYMMDD with the target date)
sqlite3 /var/lib/uh-oh/uh-oh.db ".restore '/var/backups/uh-oh/uh-oh-YYYYMMDD.db'"

# 3. Restore the symbols directory (mapping.txt / sourcemap.map files)
rm -rf /var/lib/uh-oh/symbols
tar -xzf "/var/backups/uh-oh/uh-oh-symbols-YYYYMMDD.tar.gz" -C /var/lib/uh-oh
chown -R uh-oh:uh-oh /var/lib/uh-oh/symbols

# 4. Verify the restored DB is readable
sqlite3 /var/lib/uh-oh/uh-oh.db "SELECT count(*) FROM projects;"

# 5. Restart the server
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

- Port 22/tcp rate-limited (SSH) — UFW blocks an IP that makes 6+ connection attempts within 30 seconds, throttling brute-force login attempts
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

`setup-server.sh` always runs `systemctl enable uh-oh-server.service` followed by `systemctl restart uh-oh-server.service` (not `enable --now`), so the freshly built `dist/` is actually picked up on every re-run — `enable --now` alone is a no-op on a unit that's already running and would silently leave the old code serving traffic.

---

## systemd-analyze verify

To verify the unit files are syntactically correct on a box with systemd-analyze:

```bash
systemd-analyze verify /opt/uh-oh/infra/uh-oh-server.service
systemd-analyze verify /opt/uh-oh/infra/uh-oh-backup.service
systemd-analyze verify /opt/uh-oh/infra/uh-oh-backup.timer
systemd-analyze verify /opt/uh-oh/infra/uh-oh-alert.service
```

On systems where `systemd-analyze verify` is unavailable (e.g. older distros), review the unit files manually and compare against the templates in this directory.

---

---

## nginx + TLS (subtask 15b)

### Prerequisites

- DNS: create an A record pointing `<domain>` to the server's public IP.
  Verify propagation before running the script:
  ```bash
  dig +short <domain>
  # Should return the server IP
  ```
- Ports 80 and 443 must be open — `ufw.sh` already opens them.
- `uh-oh-server.service` must be running (`setup-server.sh` run first).

### Install nginx + issue TLS certificate

```bash
bash /opt/uh-oh/infra/setup-tls.sh errors.example.com you@example.com
```

The script:

1. Installs `nginx`, `certbot`, and `python3-certbot-nginx` via apt.
2. Creates `/var/www/letsencrypt` for ACME HTTP-01 challenges.
3. Deploys a temporary HTTP-only vhost so certbot can complete the challenge.
4. Runs `certbot certonly --webroot` to issue the certificate.
5. Installs the real TLS vhost (`infra/nginx/uh-oh.conf` with `UH_OH_DOMAIN` replaced).
6. Enables `certbot.timer` for automatic renewal.

The script is idempotent — safe to re-run if the cert already exists (certbot will skip re-issuance).

### Verify

```bash
# Health check over HTTPS
curl -I https://errors.example.com/healthz
# Expected: HTTP/2 200

# TLS grade (optional)
curl -s https://api.ssllabs.com/api/v3/analyze?host=errors.example.com | jq '.status'
```

### Cert renewal

Renewal is handled automatically by `certbot.timer` (installed by the certbot package).

```bash
# Confirm the timer is active
systemctl list-timers | grep certbot

# Test a dry-run renewal
certbot renew --dry-run
```

Nginx reloads automatically on renewal via a deploy hook, **not** because of the `python3-certbot-nginx` package — that package's automatic nginx integration only applies to the `--nginx` authenticator, and `setup-tls.sh` uses `certbot certonly --webroot` instead. `setup-tls.sh` installs the reload behavior itself, in two redundant places:

- `--deploy-hook 'systemctl reload nginx'` passed to the initial `certbot certonly` call, which certbot persists into `/etc/letsencrypt/renewal/<domain>.conf`.
- A copy of the same hook at `/etc/letsencrypt/renewal-hooks/deploy/uh-oh-reload-nginx.sh`, which certbot always runs on every renewal for every cert regardless of renewal conf — this is the one that protects you if the cert is ever manually re-issued in a way that doesn't carry the `--deploy-hook` flag forward.

Verify either hook is in place after running `setup-tls.sh`:

```bash
cat /etc/letsencrypt/renewal/<domain>.conf | grep -A1 deploy_hook
ls /etc/letsencrypt/renewal-hooks/deploy/
```

### vhost details

`infra/nginx/uh-oh.conf` configures:

- HTTP → HTTPS redirect (301).
- TLS 1.3 + 1.2 only (`ssl_protocols TLSv1.3 TLSv1.2`).
- Security headers: HSTS (2 years), X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Content-Security-Policy.
- Dashboard SPA served from `/opt/uh-oh/packages/web/dist/` with SPA fallback (`try_files $uri $uri/ /index.html`).
- `index.html` explicitly `Cache-Control: no-cache` so a deploy never strands a stale shell pointing at deleted, content-hashed asset files.
- `/assets/` long-cache (1 year, `Cache-Control: public, immutable`).
- `X-Forwarded-For` is set to `$remote_addr` (overwrite, not append) on every proxied location. The server only trusts loopback proxies for this header — nginx is that trusted proxy, and it must send its own view of the client IP rather than forwarding along whatever a client claims.
- `/api/auth/login` rate-limited to 10 req/min per IP (burst 5) — a tight backstop on top of the server's own login rate limiting, since this is the highest-value brute-force target.
- `/ingest/` rate-limited to 50 req/sec per IP (burst 100, `nodelay`) — deliberately generous; a crash storm (many devices hitting the same bug at once) is legitimate traffic, this is just a ceiling.
- `/ingest/` body cap `client_max_body_size 1m` (crash envelopes are small JSON, not file uploads); `/api/` keeps the server-wide `client_max_body_size 50m` for symbol uploads.
- `/api/` and `/ingest/` (and `/api/auth/login`) reverse-proxied to `127.0.0.1:3300`.
- `/mcp` (exact match) reverse-proxied to `127.0.0.1:3300` — the JWT-gated MCP Streamable-HTTP endpoint, body capped at `client_max_body_size 1m` (JSON-RPC envelopes are small; the 50m `/api/` cap is only for symbol uploads).
- `/healthz` proxied, access log suppressed.
- `/metrics` restricted to `127.0.0.1` (deny all external access) — scrape it locally on the box, or via an SSH tunnel (`ssh -L 9090:127.0.0.1:443 <host>` then hit `https://127.0.0.1:9090/metrics` with the `Host` header set, or simpler: `ssh <host> curl -s https://127.0.0.1/metrics -k -H 'Host: <domain>'`).
- gzip for `text/plain`, `text/css`, `text/javascript`, `application/javascript`, `application/json`, `image/svg+xml`.
