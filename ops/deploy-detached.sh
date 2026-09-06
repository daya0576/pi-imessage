#!/usr/bin/env bash
set -euo pipefail

# Queue a deployment outside the currently running agent process. The delay lets
# the current assistant reply finish before the deploy script waits for drain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
LOG_DIR="${IMESSAGE_DIR}/deployments"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/deploy-$(date '+%Y%m%d-%H%M%S').log"

nohup /bin/bash -c 'sleep 10; exec "$1/deploy-blue-green.sh"' _ "${SCRIPT_DIR}" \
  >"${LOG_FILE}" 2>&1 </dev/null &
printf 'queued pid=%s log=%s\n' "$!" "${LOG_FILE}"
