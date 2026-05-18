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
# 4. Issue the certificate via webroot challenge
# ---------------------------------------------------------------------------
certbot certonly \
  --webroot \
  -w /var/www/letsencrypt \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --non-interactive

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
