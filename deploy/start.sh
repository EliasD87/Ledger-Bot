#!/usr/bin/env bash
# First start on the VPS: puts the uploaded database in place, starts Ledger and shows its log.
# Run as root after setup.sh:  bash /root/ledger-upload/deploy/start.sh
set -euo pipefail

UPLOAD=/root/ledger-upload
APP=/home/ledger/app

if [ -f "$UPLOAD/ledger.db" ]; then
  install -o ledger -g ledger -m 600 "$UPLOAD/ledger.db" "$APP/data/ledger.db"
fi

su - ledger -c 'bash -s' <<'AS_LEDGER'
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
systemctl --user enable --now ledger
sleep 15
echo "----- last lines of ~/ledger.log -----"
tail -n 15 ~/ledger.log
echo "--------------------------------------"
systemctl --user is-active ledger
AS_LEDGER

# The upload held a copy of the keys; the app has its own now.
rm -rf "$UPLOAD" /root/ledger-bundle.tar.gz
echo "Ledger is running on this server. It restarts by itself if it crashes or the server reboots."
