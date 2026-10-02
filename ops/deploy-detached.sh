#!/usr/bin/env bash
set -euo pipefail

# Queue a deployment outside the currently running agent process. The delay lets
# the current assistant reply finish before the deploy script waits for drain.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
LOG_DIR="${IMESSAGE_DIR}/deployments"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/deploy-$(date '+%Y%m%d-%H%M%S')-$$.log"
STATUS_FILE="${LOG_FILE%.log}.status.json"
SOURCE_SHA="$(git -C "${SCRIPT_DIR}/.." rev-parse HEAD)"

# Register a durable result before detaching. A log file existing is not proof
# of success; only deploy-blue-green's verified exit writes completed.
write_status() {
  /usr/bin/python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import datetime, json, os, pathlib, sys
path, state, code, source, log = sys.argv[1:]
target = pathlib.Path(path)
temporary = target.with_name(target.name + ".tmp." + str(os.getpid()))
with temporary.open("w") as handle:
    json.dump({"status": state, "exitCode": None if code == "" else int(code),
               "sourceSha": source, "logPath": log,
               "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}, handle)
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, target)
PY
}
write_status "${STATUS_FILE}" queued "" "${SOURCE_SHA}" "${LOG_FILE}"
export -f write_status

# Run blue-green; on ANY failure, auto-run the idempotent repair helper so a
# crashed/aborted deploy cannot leave a stale lock, orphan green process,
# orphan release dir, or (post-switch) an unhealthy current release.
nohup /bin/bash -c '
  sleep 10
  write_status "$2" running "" "$3" "$4"
  "$1/deploy-blue-green.sh"
  rc=$?
  if [ "$rc" != "0" ]; then
    echo "[detached] deploy exit=$rc; running auto-repair" >&2
    "$1/deploy-repair.sh" || echo "[detached] auto-repair reported problems" >&2
  fi
  if [ "$rc" = "0" ]; then
    write_status "$2" completed "$rc" "$3" "$4"
  else
    write_status "$2" failed "$rc" "$3" "$4"
  fi
  exit "$rc"
' _ "${SCRIPT_DIR}" "${STATUS_FILE}" "${SOURCE_SHA}" "${LOG_FILE}" \
  >"${LOG_FILE}" 2>&1 </dev/null &
printf 'queued pid=%s log=%s status=%s\n' "$!" "${LOG_FILE}" "${STATUS_FILE}"
