#!/usr/bin/env bash
# Update the hosted room to what is on GitHub main.  Run from the Mac:
#   ROOM_HOST=root@<droplet ip> ./deploy/deploy.sh
# A restart mid-hand is safe: hands resume from the event log and clients reconnect by themselves.
set -euo pipefail
: "${ROOM_HOST:?set ROOM_HOST=root@<droplet ip>}"
KEY=${ROOM_SSH_KEY:-$HOME/.ssh/id_ed25519}

git -C "$(dirname "$0")/.." push origin main
ssh -i "$KEY" "$ROOM_HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/poker-room
git fetch -q origin && git reset -q --hard origin/main
(cd server && npm ci --omit=dev --silent)
install -m 644 deploy/poker-room.service /etc/systemd/system/poker-room.service
systemctl daemon-reload
systemctl restart poker-room
sleep 2
systemctl is-active poker-room && curl -fsS http://127.0.0.1:8790/health && echo " — room is up at $(git rev-parse --short HEAD)"
REMOTE
