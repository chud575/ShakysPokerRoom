#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 droplet for the poker room.  Run as root:
#   bash setup.sh
# Then fill in /etc/poker-room.env, /etc/litestream.yml and /etc/default/litestream (see DEPLOY.md).
set -euo pipefail

REPO=https://github.com/chud575/ShakysPokerRoom.git
LITESTREAM=0.3.13

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
DEBIAN_FRONTEND=noninteractive apt-get -y install nginx certbot python3-certbot-nginx ufw git curl sqlite3 unattended-upgrades

# Node 24 (the room runs TypeScript directly; no build step)
if ! node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get -y install nodejs
fi

# Litestream (continuous SQLite backup)
if ! command -v litestream >/dev/null; then
  curl -fsSL -o /tmp/litestream.deb "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM}/litestream-v${LITESTREAM}-linux-amd64.deb"
  dpkg -i /tmp/litestream.deb
fi

# service user, code and data
id pokerroom >/dev/null 2>&1 || useradd --system --home /var/lib/poker-room --shell /usr/sbin/nologin pokerroom
install -d -o pokerroom -g pokerroom -m 750 /var/lib/poker-room
if [ ! -d /opt/poker-room/.git ]; then git clone "$REPO" /opt/poker-room; fi
(cd /opt/poker-room/server && npm ci --omit=dev)

# config templates (not overwritten if present)
[ -f /etc/poker-room.env ] || install -m 640 -o root -g pokerroom /opt/poker-room/deploy/poker-room.env.example /etc/poker-room.env
[ -f /etc/litestream.yml ] || install -m 644 /opt/poker-room/deploy/litestream.yml /etc/litestream.yml
install -m 644 /opt/poker-room/deploy/poker-room.service /etc/systemd/system/poker-room.service
install -m 644 /opt/poker-room/deploy/room.nginx /etc/nginx/sites-available/poker-room
ln -sf /etc/nginx/sites-available/poker-room /etc/nginx/sites-enabled/poker-room
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# firewall: ssh + web only
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

systemctl daemon-reload
systemctl enable poker-room litestream
echo
echo "Setup done.  Next: fill in /etc/poker-room.env, /etc/litestream.yml, /etc/default/litestream,"
echo "then:  systemctl start poker-room litestream  and  certbot --nginx -d room.shakybetspokertools.com"
