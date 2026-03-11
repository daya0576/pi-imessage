#!/usr/bin/env bash
# Start blue in the background via pm2.
set -euo pipefail
cd "$(dirname "$0")/.."

pm2 start npm --name blue -- run start
pm2 save
echo "✓ blue started. Use 'pm2 logs blue' to tail logs."
