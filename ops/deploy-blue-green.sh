#!/usr/bin/env bash
set -euo pipefail

# Build an immutable release, validate it as a shadow worker, drain the active
# worker, atomically switch current, and roll back if post-switch health fails.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
RELEASE_ROOT="${RELEASE_ROOT:-${IMESSAGE_DIR}/releases}"
CURRENT_LINK="${RELEASE_ROOT}/current"
PREVIOUS_LINK="${RELEASE_ROOT}/previous"
LOCK_DIR="${IMESSAGE_DIR}/deploy.lock"
SERVICE="gui/$(id -u)/com.kingcrab.pi-imessage"
ACTIVE_URL="${ACTIVE_URL:-http://127.0.0.1:7750}"
GREEN_PORT="${GREEN_PORT:-7751}"
GREEN_URL="http://127.0.0.1:${GREEN_PORT}"
DRAIN_TIMEOUT_SECONDS="${DRAIN_TIMEOUT_SECONDS:-1800}"
START_TIMEOUT_SECONDS="${START_TIMEOUT_SECONDS:-90}"
DEPLOY_CHAT_GUID="${DEPLOY_CHAT_GUID:-}"
BOOTSTRAP="${BOOTSTRAP:-auto}"

GREEN_PID=""
NEW_RELEASE=""
OLD_TARGET=""
SWITCHED=false
DEPLOY_SUCCEEDED=false

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

send_progress() {
  [[ -n "${DEPLOY_CHAT_GUID}" ]] || return 0
  local text="$1"
  /usr/bin/curl -fsS --max-time 10 -X POST "${ACTIVE_URL}/send" \
    -H 'Content-Type: application/json' \
    -d "$(/usr/bin/python3 -c 'import json,sys; print(json.dumps({"chatGuid":sys.argv[1],"text":sys.argv[2]}))' "${DEPLOY_CHAT_GUID}" "${text}")" \
    >/dev/null 2>&1 || true
}

cleanup() {
  local rc=$?
  trap - EXIT
  if [[ "${rc}" != "0" && "${SWITCHED}" == "true" && "${DEPLOY_SUCCEEDED}" != "true" ]]; then
    log "Deployment failed after switch (exit=${rc}); forcing rollback"
    rollback || log "Emergency rollback could not restore service"
  fi
  if [[ -n "${GREEN_PID}" ]] && kill -0 "${GREEN_PID}" 2>/dev/null; then
    kill -TERM "${GREEN_PID}" 2>/dev/null || true
    wait "${GREEN_PID}" 2>/dev/null || true
  fi
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  exit "${rc}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

json_field() {
  /usr/bin/python3 -c 'import json,sys; data=json.load(sys.stdin); value=data'"$1"'; print(str(value).lower() if isinstance(value,bool) else value)'
}

wait_http() {
  local url="$1" timeout="$2" deadline
  deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if /usr/bin/curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

check_model() {
  local base_url="$1" result
  result="$(/usr/bin/curl -fsS --max-time 45 "${base_url}/health/model")" || return 1
  [[ "$(printf '%s' "${result}" | json_field '["ok"]')" == "true" ]] || return 1
  log "LLM probe passed: $(printf '%s' "${result}" | json_field '["model"]')"
}

atomic_link() {
  local target="$1"
  local link="$2"
  local temp="${link}.new.$$"
  rm -f "${temp}"
  ln -s "${target}" "${temp}"
  /bin/mv -fh "${temp}" "${link}"
}

start_active_service() {
  local plist="${HOME}/Library/LaunchAgents/com.kingcrab.pi-imessage.plist"
  if launchctl print "${SERVICE}" >/dev/null 2>&1; then
    launchctl kickstart -k "${SERVICE}"
    return
  fi
  [[ -f "${plist}" ]] || return 1
  # launchctl can transiently return EIO immediately after a bootout. Retry
  # bootstrap without first destroying any healthy loaded service.
  for delay in 0 1 2 4; do
    (( delay == 0 )) || sleep "${delay}"
    launchctl bootstrap "gui/$(id -u)" "${plist}" >/dev/null 2>&1 && return 0
  done
  return 1
}

rollback() {
  [[ -n "${OLD_TARGET}" ]] || return 1
  log "Rolling back to ${OLD_TARGET}"
  atomic_link "${OLD_TARGET}" "${CURRENT_LINK}"
  start_active_service || true
  if wait_http "${ACTIVE_URL}/health/runtime" "${START_TIMEOUT_SECONDS}"; then
    send_progress "pi-imessage 新版本切换失败，旧版本已自动恢复。"
    return 0
  fi
  return 1
}

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "Another deployment is active: ${LOCK_DIR}" >&2
  exit 1
fi
mkdir -p "${RELEASE_ROOT}"

if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
  echo "Repository must be clean; commit the deployment candidate first." >&2
  exit 1
fi

SHA="$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD)"
VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "${REPO_ROOT}/package.json")"
STAMP="$(date '+%Y%m%d-%H%M%S')"
NEW_RELEASE="${RELEASE_ROOT}/pi-imessage-${VERSION}-${SHA}-${STAMP}"
mkdir -p "${NEW_RELEASE}"

log "Creating immutable release ${NEW_RELEASE}"
git -C "${REPO_ROOT}" archive HEAD | tar -x -C "${NEW_RELEASE}"
(
  cd "${NEW_RELEASE}"
  npm ci
  npm run check
  npm test
  npm run build
  npm audit --omit=dev --audit-level=high
)

SMOKE_WORKSPACE="${NEW_RELEASE}/.smoke-workspace"
mkdir -p "${SMOKE_WORKSPACE}"
printf '%s\n' '{"chatAllowlist":{"whitelist":[],"blacklist":["*"]},"richText":{"enabled":false,"markdown":true}}' \
  > "${SMOKE_WORKSPACE}/settings.json"

log "Starting green in shadow mode on ${GREEN_URL}"
env WEB_ENABLED=true WEB_HOST=127.0.0.1 WEB_PORT="${GREEN_PORT}" WORKER_ENABLED=false \
  WORKING_DIR="${SMOKE_WORKSPACE}" \
  /opt/homebrew/bin/node "${NEW_RELEASE}/dist/main.js" \
  >"${NEW_RELEASE}/green-smoke.log" 2>&1 &
GREEN_PID=$!

wait_http "${GREEN_URL}/health/runtime" "${START_TIMEOUT_SECONDS}"
RUNTIME="$(/usr/bin/curl -fsS --max-time 5 "${GREEN_URL}/health/runtime")"
[[ "$(printf '%s' "${RUNTIME}" | json_field '["activePrompts"]')" == "0" ]]
check_model "${GREEN_URL}"
kill -TERM "${GREEN_PID}"
wait "${GREEN_PID}"
GREEN_PID=""
log "Green validation passed"
send_progress "pi-imessage 新版本已通过测试和真实 LLM 健康检查；等当前回复处理完后再切换。"

# Never kill a live prompt. This also means an agent must launch this script in
# detached mode after sending its reply, rather than synchronously as a tool.
legacy_active_prompts() {
  /usr/bin/python3 - "${IMESSAGE_DIR}/logs/stdout.log" <<'PY'
import re, sys
state = {}
try:
    with open(sys.argv[1], "rb") as handle:
        handle.seek(0, 2)
        handle.seek(max(0, handle.tell() - 20_000_000))
        lines = handle.read().decode("utf-8", "replace").splitlines()
except FileNotFoundError:
    print(0); raise SystemExit
for line in lines:
    line = line.lstrip("\x00")
    start = re.match(r"^\[([^]]+)\] \[agent\] prompt start: (.+?) model=", line)
    end = re.match(r"^\[([^]]+)\] \[agent\] prompt end: (.+?) total_ms=", line)
    event = start or end
    if event:
        timestamp, chat = event.group(1), event.group(2)
        # Tool output can quote older log lines. Only accept chronological state
        # changes for each chat so quoted history cannot fake a prompt end.
        if chat not in state or timestamp >= state[chat][0]:
            state[chat] = (timestamp, bool(start))
    elif re.match(r"^\[[^]]+\] \[sid\] Shutting down", line):
        state.clear()
print(sum(active for _, active in state.values()))
PY
}

DEADLINE=$((SECONDS + DRAIN_TIMEOUT_SECONDS))
while (( SECONDS < DEADLINE )); do
  RUNTIME="$(/usr/bin/curl -fsS --max-time 5 "${ACTIVE_URL}/health/runtime" 2>/dev/null || true)"
  ACTIVE=""
  if [[ -n "${RUNTIME}" ]]; then
    ACTIVE="$(printf '%s' "${RUNTIME}" | json_field '["activePrompts"]' 2>/dev/null || true)"
  fi
  # Legacy releases return the HTML dashboard for unknown routes. Fall back to
  # reconstructing active prompt state from the service log during the first migration.
  if [[ ! "${ACTIVE}" =~ ^[0-9]+$ ]]; then ACTIVE="$(legacy_active_prompts)"; fi
  [[ "${ACTIVE}" == "0" ]] && break
  sleep 2
done
if (( SECONDS >= DEADLINE )); then
  echo "Timed out waiting for active prompts to drain" >&2
  exit 1
fi

if [[ -L "${CURRENT_LINK}" ]]; then OLD_TARGET="$(readlink "${CURRENT_LINK}")"; fi
if [[ -n "${OLD_TARGET}" ]]; then atomic_link "${OLD_TARGET}" "${PREVIOUS_LINK}"; fi
atomic_link "${NEW_RELEASE}" "${CURRENT_LINK}"
SWITCHED=true

log "Switching active service to ${NEW_RELEASE}"
# Ordinary releases never bootout the live LaunchAgent. Its plist points at the
# stable current symlink, so kickstart is sufficient. If it is unexpectedly
# unloaded, bootstrap it with retries; any failure is caught by the EXIT trap.
start_active_service
if ! wait_http "${ACTIVE_URL}/health/runtime" "${START_TIMEOUT_SECONDS}" || ! check_model "${ACTIVE_URL}"; then
  exit 1
fi

DEPLOY_SUCCEEDED=true
send_progress "pi-imessage 已完成蓝绿切换，切换后真实 LLM 健康检查通过。"
log "Deployment succeeded"

# Resolve every candidate and reference through the same filesystem namespace.
# Cleanup is fail-closed and best-effort, never a reason to damage a healthy release.
/usr/bin/python3 "${SCRIPT_DIR}/prune-releases.py" "${RELEASE_ROOT}" "${CURRENT_LINK}" "${PREVIOUS_LINK}" --apply \
  || log "Release cleanup skipped; retained builds for operator review"
