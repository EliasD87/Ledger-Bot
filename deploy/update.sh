#!/usr/bin/env bash
# Updates Ledger on the VPS to the latest code on GitHub (branch main). Run as root, from the laptop:
#   ssh root@<server-ip> "curl -fsSL https://raw.githubusercontent.com/EliasD87/Ledger-Bot/main/deploy/update.sh | bash"
# Keeps .env and data/ as they are, rebuilds, restarts and shows the log. Touches only the "ledger" user.
set -euo pipefail

su - ledger -c 'bash -s' <<'AS_LEDGER'
set -euo pipefail
cd ~/app
curl -fsSL https://github.com/EliasD87/Ledger-Bot/archive/refs/heads/main.tar.gz | tar -xz --strip-components=1
. "$HOME/.nvm/nvm.sh"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart ledger
sleep 12
echo "----- last lines of ~/ledger.log -----"
tail -n 8 ~/ledger.log
echo "--------------------------------------"
systemctl --user is-active ledger
AS_LEDGER
echo "Ledger is updated to the latest code on GitHub."
