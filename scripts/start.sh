#!/usr/bin/env bash
# Start sid in the background via pm2.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v pm2 &>/dev/null; then
  read -rp "pm2 not found. Install globally via npm? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    npm install -g pm2
  else
    echo "Aborted. Install pm2 manually and retry."
    exit 1
  fi
fi

pm2 start npm --name sid -- run start
pm2 save
echo "✓ sid started. Use 'pm2 logs sid' to tail logs."
