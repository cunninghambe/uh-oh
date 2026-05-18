#!/usr/bin/env bash
set -euo pipefail

ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http for certbot'
ufw allow 443/tcp comment 'https'
# 3300 NOT exposed; nginx proxies on 127.0.0.1

ufw status verbose
