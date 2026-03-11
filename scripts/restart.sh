#!/usr/bin/env bash
# Restart blue (or start if not running).
set -euo pipefail
cd "$(dirname "$0")/.."

if pm2 describe blue &>/dev/null; then
  pm2 restart blue
  echo "✓ blue restarted."
else
  pm2 start npm --name blue -- run start
  pm2 save
  echo "✓ blue was not running, started."
fi
