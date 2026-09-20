#!/usr/bin/env bash
set -euo pipefail

# Queue a deployment outside the currently running agent process. The delay lets
# the current assistant reply finish before the deploy script waits for drain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
LOG_DIR="${IMESSAGE_DIR}/deployments"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/deploy-$(date '+%Y%m%d-%H%M%S').log"

# Run blue-green; on ANY failure, auto-run the idempotent repair helper so a
# crashed/aborted deploy cannot leave a stale lock, orphan green process,
# orphan release dir, or (post-switch) an unhealthy current release.
nohup /bin/bash -c '
  sleep 10
  "$1/deploy-blue-green.sh"
  rc=$?
  if [ "$rc" != "0" ]; then
    echo "[detached] deploy exit=$rc; running auto-repair" >&2
    "$1/deploy-repair.sh" || echo "[detached] auto-repair reported problems" >&2
  fi
  exit "$rc"
' _ "${SCRIPT_DIR}" \
  >"${LOG_FILE}" 2>&1 </dev/null &
printf 'queued pid=%s log=%s\n' "$!" "${LOG_FILE}"
