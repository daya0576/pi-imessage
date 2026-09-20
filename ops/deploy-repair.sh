#!/usr/bin/env bash
set -uo pipefail

# Idempotent, fail-closed repair for a failed/aborted blue-green deploy.
# Safe to run any time: it never touches a healthy live release. It only
# cleans state that a crashed or hard-killed deploy can leave behind, and
# rolls back to previous ONLY if current is genuinely unhealthy.
#
# Repairs, in order:
#   1. Remove a stale deploy.lock when no deploy process is running.
#   2. Kill an orphan shadow (green) process on GREEN_PORT when no deploy runs.
#   3. If current is unhealthy and previous exists+is healthy-capable, roll back.
#   4. Remove orphan release dirs not referenced by current/previous (best-effort).
# It prints a JSON summary of what it did to stdout.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
RELEASE_ROOT="${RELEASE_ROOT:-${IMESSAGE_DIR}/releases}"
CURRENT_LINK="${RELEASE_ROOT}/current"
PREVIOUS_LINK="${RELEASE_ROOT}/previous"
LOCK_DIR="${IMESSAGE_DIR}/deploy.lock"
SERVICE="gui/$(id -u)/com.kingcrab.pi-imessage"
ACTIVE_URL="${ACTIVE_URL:-http://127.0.0.1:7750}"
GREEN_PORT="${GREEN_PORT:-7751}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-90}"

ACTIONS=()
add() { ACTIONS+=("$1"); }

log() { printf '[%s] [repair] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }

deploy_running() {
  # A live blue-green run is identifiable by its own process; check for the
  # script name in the process table. Conservative: if in doubt, assume running.
  pgrep -f 'deploy-blue-green\.sh' >/dev/null 2>&1
}

health_ok() {
  /usr/bin/curl -fsS --max-time 5 "${ACTIVE_URL}/health/runtime" >/dev/null 2>&1
}

wait_health() {
  local deadline=$((SECONDS + START_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    health_ok && return 0
    sleep 1
  done
  return 1
}

start_service() {
  local plist="${HOME}/Library/LaunchAgents/com.kingcrab.pi-imessage.plist"
  if launchctl print "${SERVICE}" >/dev/null 2>&1; then
    launchctl kickstart -k "${SERVICE}"; return
  fi
  [[ -f "${plist}" ]] || return 1
  for delay in 0 1 2 4; do
    (( delay == 0 )) || sleep "${delay}"
    launchctl bootstrap "gui/$(id -u)" "${plist}" >/dev/null 2>&1 && return 0
  done
  return 1
}

atomic_link() {
  local target="$1" link="$2" temp="$2.new.$$"
  rm -f "${temp}"; ln -s "${target}" "${temp}"; /bin/mv -fh "${temp}" "${link}"
}

# 1. Stale lock ---------------------------------------------------------------
if [[ -d "${LOCK_DIR}" ]]; then
  if deploy_running; then
    add "lock-held-by-active-deploy(skipped)"
    log "deploy running; leaving lock and exiting without changes"
    /usr/bin/python3 -c 'import json,sys; print(json.dumps({"repaired":False,"reason":"deploy-active","actions":sys.argv[1:]}))' "${ACTIONS[@]}"
    exit 0
  fi
  rmdir "${LOCK_DIR}" 2>/dev/null && add "removed-stale-lock" || add "stale-lock-remove-failed"
fi

# 2. Orphan green process -----------------------------------------------------
if ! deploy_running; then
  GREEN_PIDS="$(lsof -ti tcp:"${GREEN_PORT}" 2>/dev/null || true)"
  if [[ -n "${GREEN_PIDS}" ]]; then
    kill -TERM ${GREEN_PIDS} 2>/dev/null || true
    sleep 2
    STILL="$(lsof -ti tcp:"${GREEN_PORT}" 2>/dev/null || true)"
    [[ -n "${STILL}" ]] && kill -KILL ${STILL} 2>/dev/null || true
    add "killed-orphan-green:${GREEN_PORT}"
  fi
fi

# 3. Health / rollback --------------------------------------------------------
if health_ok; then
  add "current-healthy"
else
  add "current-unhealthy"
  # Try a plain restart of current first (least destructive).
  start_service || true
  if wait_health; then
    add "recovered-by-restart"
  elif [[ -L "${PREVIOUS_LINK}" ]]; then
    PREV="$(readlink "${PREVIOUS_LINK}")"
    if [[ -n "${PREV}" && -d "${PREV}" && "$(readlink "${CURRENT_LINK}")" != "${PREV}" ]]; then
      log "rolling back current -> ${PREV}"
      atomic_link "${PREV}" "${CURRENT_LINK}"
      start_service || true
      if wait_health; then add "rolled-back-to-previous"; else add "rollback-failed-still-unhealthy"; fi
    else
      add "no-usable-previous"
    fi
  else
    add "no-previous-link"
  fi
fi

# 4. Orphan release dirs (best-effort, only when no deploy running) -----------
if ! deploy_running; then
  CUR="$(readlink "${CURRENT_LINK}" 2>/dev/null || true)"
  PRE="$(readlink "${PREVIOUS_LINK}" 2>/dev/null || true)"
  CUR="$(cd "${CUR}" 2>/dev/null && pwd -P || echo "${CUR}")"
  PRE="$(cd "${PRE}" 2>/dev/null && pwd -P || echo "${PRE}")"
  removed=0
  for d in "${RELEASE_ROOT}"/pi-imessage-*; do
    [[ -d "${d}" ]] || continue
    dp="$(cd "${d}" && pwd -P)"
    [[ "${dp}" == "${CUR}" || "${dp}" == "${PRE}" ]] && continue
    # Only remove dirs that look incomplete (no node_modules or no dist) to avoid
    # deleting a valid retained release the pruner would otherwise keep.
    if [[ ! -d "${d}/node_modules" || ! -d "${d}/dist" ]]; then
      rm -rf "${d}" && removed=$((removed+1))
    fi
  done
  (( removed > 0 )) && add "removed-orphan-incomplete-releases:${removed}"
fi

REPAIRED=false
for a in "${ACTIONS[@]}"; do
  case "$a" in
    removed-stale-lock|killed-orphan-green:*|rolled-back-to-previous|recovered-by-restart|removed-orphan-incomplete-releases:*) REPAIRED=true;;
  esac
done

/usr/bin/python3 -c 'import json,sys; print(json.dumps({"repaired": sys.argv[1]=="true", "healthy": sys.argv[2]=="true", "actions": sys.argv[3:]}))' \
  "${REPAIRED}" "$(health_ok && echo true || echo false)" "${ACTIONS[@]}"
