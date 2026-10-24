#!/usr/bin/env bash
# Updates Ledger on the VPS to the latest code on GitHub (branch main). Run as root, from the laptop:
#   ssh root@<server-ip> "curl -fsSL https://raw.githubusercontent.com/EliasD87/Ledger-Bot/main/deploy/update.sh | bash"
# Builds the new code in a separate folder first; only if that succeeds does it replace the old code
# (so files deleted on GitHub disappear here too) and restart. Keeps .env and data/ as they are.
# Touches only the "ledger" user.
set -euo pipefail

su - ledger -c 'bash -s' <<'AS_LEDGER'
set -euo pipefail
. "$HOME/.nvm/nvm.sh"
NEW="$HOME/app.new"
rm -rf "$NEW"
mkdir -p "$NEW"
curl -fsSL https://github.com/EliasD87/Ledger-Bot/archive/refs/heads/main.tar.gz | tar -xz -C "$NEW" --strip-components=1
cd "$NEW"
npm ci --no-audit --no-fund --loglevel=error
if ! npm run build --silent; then
  rm -rf "$NEW"
  echo "The new code didn't build, so nothing was changed: the current Ledger keeps running."
  exit 1
fi

# Swap: everything except the keys and the database is replaced by the new build.
cd "$HOME/app"
find . -mindepth 1 -maxdepth 1 ! -name .env ! -name data -exec rm -rf {} +
cp -a "$NEW"/. "$HOME/app"/
rm -rf "$NEW"

export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart ledger
sleep 15
echo "----- last lines of ~/ledger.log -----"
tail -n 10 ~/ledger.log
echo "--------------------------------------"
systemctl --user is-active ledger
AS_LEDGER
echo "Ledger is updated to the latest code on GitHub."
