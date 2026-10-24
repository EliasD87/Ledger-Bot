#!/usr/bin/env bash
# Installs or updates Ledger on the shared VPS. Run as root from the unpacked upload:
#   bash /root/ledger-upload/deploy/setup.sh
# Touches only the "ledger" Linux user and its home. Safe to run again: that is how updates ship.
set -euo pipefail

UPLOAD=/root/ledger-upload
APP=/home/ledger/app

echo "== 1/4 Ledger's own user"
id ledger >/dev/null 2>&1 || adduser --disabled-password --gecos "" ledger
loginctl enable-linger ledger # keeps its service running when nobody is logged in

echo "== 2/4 Code and settings"
mkdir -p "$APP/data"
tar -xzf "$UPLOAD/code.tar.gz" -C "$APP"
install -m 600 "$UPLOAD/.env" "$APP/.env"
chown -R ledger:ledger "$APP"

echo "== 3/4 Node, build and checks (as ledger)"
su - ledger -c 'bash -s' <<'AS_LEDGER'
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] || curl -fsSo- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null
. "$NVM_DIR/nvm.sh"
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null
cd ~/app
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
npm run check

# The service: capped well inside our budget so it can never crowd the other bots on this box.
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ledger.service <<UNIT
[Unit]
Description=Ledger Discord bot
After=network-online.target

[Service]
WorkingDirectory=%h/app
ExecStart=$(command -v node) --max-old-space-size=384 dist/index.js
Restart=always
RestartSec=10
MemoryMax=512M
CPUQuota=100%
StandardOutput=append:%h/ledger.log
StandardError=append:%h/ledger.log

[Install]
WantedBy=default.target
UNIT

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
if systemctl --user is-active --quiet ledger; then
  systemctl --user restart ledger
  echo "UPDATED: Ledger restarted with the new code."
fi
AS_LEDGER

echo "== 4/4 Done"
if [ ! -f "$APP/data/ledger.db" ]; then
  echo "Setup finished. Ledger is NOT started yet: next, stop the bot on the laptop and upload the database."
fi
