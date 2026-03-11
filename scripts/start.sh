#!/usr/bin/env bash
# Start sid in the background via pm2.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pm2 &>/dev/null; then
  echo "pm2 not found, installing globally…"
  npm install -g pm2
fi

pm2 start npm --name sid -- run start
pm2 save
echo "✓ sid started. Use 'pm2 logs sid' to tail logs."
