#!/usr/bin/env bash
# infra/setup-tls.sh — install nginx + certbot, issue TLS cert, enable renewal.
# Must be run as root on Ubuntu 22.04+.
# Usage: setup-tls.sh <domain> <email>
#
# Pre-requisites:
#   1. DNS A record for <domain> pointing to this server's IP.
#   2. Ports 80 and 443 open (ufw.sh already opens them).
#   3. uh-oh-server.service running (setup-server.sh must have been run first).
set -euo pipefail

DOMAIN="${1:?Usage: setup-tls.sh <domain> <email>}"
EMAIL="${2:?Usage: setup-tls.sh <domain> <email>}"

# ---------------------------------------------------------------------------
# 1. Install nginx + certbot
# ---------------------------------------------------------------------------
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx

# Disable default nginx site if present
rm -f /etc/nginx/sites-enabled/default

# ---------------------------------------------------------------------------
# 2. Create webroot directory for ACME HTTP-01 challenges
# ---------------------------------------------------------------------------
mkdir -p /var/www/letsencrypt

# ---------------------------------------------------------------------------
# 3. Deploy a minimal HTTP-only vhost so certbot can complete the challenge.
#    We temporarily use this instead of the real vhost (which references TLS
#    certs that do not yet exist and would fail nginx -t).
# ---------------------------------------------------------------------------
ACME_CONF=/etc/nginx/sites-available/uh-oh-acme.conf
cat > "$ACME_CONF" <<ACME_EOF
server {
  listen 80;
  listen [::]:80;
  server_name ${DOMAIN};
  location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
  location / { return 200 'pending TLS'; add_header Content-Type text/plain; }
}
ACME_EOF

ln -sf "$ACME_CONF" /etc/nginx/sites-enabled/uh-oh.conf
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
# 3b. Deploy hook: reload nginx after every renewal.
#     `certonly --webroot` has no built-in nginx integration (that's only
#     wired up by the `--nginx` authenticator, which we don't use here), so
#     without this, cert renewal succeeds silently but nginx keeps serving
#     the expiring cert until something else reloads it — a guaranteed
#     outage around day 90. Belt and braces:
#       (a) --deploy-hook below writes the hook path into this cert's
#           renewal conf (/etc/letsencrypt/renewal/<domain>.conf), so it
#           persists across `certbot renew`.
#       (b) a copy is also dropped into renewal-hooks/deploy/, which
#           certbot always runs for every cert regardless of renewal conf —
#           this survives a manual `certbot certonly` re-issuance that
#           might not carry the --deploy-hook flag forward.
# ---------------------------------------------------------------------------
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/uh-oh-reload-nginx.sh <<'HOOK_EOF'
#!/bin/sh
systemctl reload nginx
HOOK_EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/uh-oh-reload-nginx.sh

# ---------------------------------------------------------------------------
# 4. Issue the certificate via webroot challenge
# ---------------------------------------------------------------------------
certbot certonly \
  --webroot \
  -w /var/www/letsencrypt \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive \
  --deploy-hook 'systemctl reload nginx'

# ---------------------------------------------------------------------------
# 5. Install the real vhost (with TLS) and reload nginx
# ---------------------------------------------------------------------------
REAL_CONF=/etc/nginx/sites-available/uh-oh.conf
sed "s/UH_OH_DOMAIN/${DOMAIN}/g" /opt/uh-oh/infra/nginx/uh-oh.conf > "$REAL_CONF"

# Replace the symlink to point at the real vhost
ln -sf "$REAL_CONF" /etc/nginx/sites-enabled/uh-oh.conf

# Remove the temporary acme vhost (it's no longer needed — the real vhost
# also handles /.well-known/acme-challenge/ for future renewals)
rm -f "$ACME_CONF"

nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
# 6. Enable the certbot renewal timer (installed by the certbot package)
# ---------------------------------------------------------------------------
systemctl enable --now certbot.timer

echo ""
echo "TLS issued for ${DOMAIN}."
echo "Dashboard: https://${DOMAIN}"
echo "Healthz:   curl -I https://${DOMAIN}/healthz"
echo "Renewal:   systemctl list-timers | grep certbot"
