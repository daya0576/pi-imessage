#!/usr/bin/env bash
set -uo pipefail

# Conservative active/passive watchdog. It never edits source or dependencies.
# Recovery is limited to restart and immutable-release rollback.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
RELEASE_ROOT="${RELEASE_ROOT:-${IMESSAGE_DIR}/releases}"
CURRENT_LINK="${RELEASE_ROOT}/current"
PREVIOUS_LINK="${RELEASE_ROOT}/previous"
DEPLOY_LOCK="${IMESSAGE_DIR}/deploy.lock"
WATCHDOG_DIR="${IMESSAGE_DIR}/watchdog"
STATE_FILE="${WATCHDOG_DIR}/immutable-state.env"
LOG_FILE="${WATCHDOG_DIR}/watchdog.log"
SERVICE="gui/$(id -u)/com.kingcrab.pi-imessage"
WEB_URL="http://127.0.0.1:7750"
STUCK_SECONDS="${AGENT_STUCK_SECONDS:-600}"
MODEL_PROBE_INTERVAL_SECONDS="${MODEL_PROBE_INTERVAL_SECONDS:-900}"
mkdir -p "${WATCHDOG_DIR}"

log() { printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"${LOG_FILE}"; }

# A deployment owns restart/rollback while its lock is present. Ignore stale
# locks after 45 minutes so a killed deploy cannot disable recovery forever.
if [[ -d "${DEPLOY_LOCK}" ]]; then
  AGE=$(( $(date +%s) - $(stat -f %m "${DEPLOY_LOCK}" 2>/dev/null || echo 0) ))
  if (( AGE < 2700 )); then exit 0; fi
  log "Removing stale deployment lock age=${AGE}s"
  rmdir "${DEPLOY_LOCK}" 2>/dev/null || exit 0
fi

launch_running() { launchctl print "${SERVICE}" 2>/dev/null | grep -q 'state = running'; }
web_healthy() { curl -fsS --max-time 4 "${WEB_URL}/health/runtime" >/dev/null 2>&1; }
runtime_stuck() {
  local result active last now last_epoch
  result="$(curl -fsS --max-time 4 "${WEB_URL}/health/runtime" 2>/dev/null)" || return 1
  active="$(printf '%s' "${result}" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("activePrompts",0))' 2>/dev/null)" || return 1
  (( active > 0 )) || return 1
  last="$(printf '%s' "${result}" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("lastAgentActivityAt") or "")' 2>/dev/null)"
  [[ -n "${last}" ]] || return 1
  last_epoch="$(/usr/bin/python3 -c 'from datetime import datetime; import sys; print(int(datetime.fromisoformat(sys.argv[1].replace("Z","+00:00")).timestamp()))' "${last}" 2>/dev/null)" || return 1
  now="$(date +%s)"
  (( now - last_epoch >= STUCK_SECONDS ))
}

model_probe() {
  local result
  result="$(curl -fsS --max-time 45 "${WEB_URL}/health/model" 2>/dev/null)" || return 1
  [[ "$(printf '%s' "${result}" | /usr/bin/python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("ok",False)).lower())' 2>/dev/null)" == "true" ]]
}

restart_and_verify() {
  launchctl kickstart -k "${SERVICE}" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    sleep 1
    # Only gate recovery on conditions restarting this worker can repair.
    # Messages account availability is external and must not cause restart loops.
    launch_running && web_healthy && return 0
  done
  return 1
}

rollback() {
  [[ -L "${PREVIOUS_LINK}" ]] || return 1
  local previous temp
  previous="$(readlink "${PREVIOUS_LINK}")"
  temp="${CURRENT_LINK}.watchdog.$$"
  ln -s "${previous}" "${temp}" || return 1
  /bin/mv -fh "${temp}" "${CURRENT_LINK}" || return 1
  log "Rolled back current to ${previous}"
  restart_and_verify
}

if ! launch_running || ! web_healthy || runtime_stuck; then
  log "Local health failed; restarting active immutable release"
  if ! restart_and_verify; then
    log "Restart failed; attempting previous release"
    rollback || log "Rollback failed"
  fi
  exit 0
fi

LAST_MODEL_PROBE_EPOCH=0
[[ -f "${STATE_FILE}" ]] && source "${STATE_FILE}" 2>/dev/null || true
NOW="$(date +%s)"
if (( NOW - LAST_MODEL_PROBE_EPOCH >= MODEL_PROBE_INTERVAL_SECONDS )); then
  if model_probe; then
    log "Deep health passed: real LLM probe ok"
  else
    # An upstream model outage is observable but is not repaired by repeatedly
    # restarting a healthy local worker.
    log "Deep health failed: real LLM probe unavailable"
  fi
  printf 'LAST_MODEL_PROBE_EPOCH=%q\n' "${NOW}" >"${STATE_FILE}"
fi
