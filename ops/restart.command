#!/bin/bash
# One-shot restart controller (ops/README.md, step 3). Runs from a private
# directory holding environment.sh and control.sh; the restart_service tool
# writes them, an operator writes them by hand. Stops the recorded old process,
# waits for it to exit, then becomes the new service process.
set -euo pipefail
umask 077
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/environment.sh"
rm -f "$DEPLOY_DIR/environment.sh"
source "$DEPLOY_DIR/control.sh"
: "${OLD_PID:?}" "${OLD_STARTED:?}" "${EXPECTED_COMMAND:?}"
: "${REPO:?}" "${NODE:?}" "${WORKING_DIR:?}" "${WEB_PORT:?}" "${LOG_FILE:?}"
cd "$REPO"
exec 3>>"$DEPLOY_DIR/controller.log"
[ "$(ps -p "$OLD_PID" -o lstart=)" = "$OLD_STARTED" ]
[ "$(ps -p "$OLD_PID" -o command=)" = "$EXPECTED_COMMAND" ]
printf '%s stopping pid=%s\n' "$(date -u +%FT%TZ)" "$OLD_PID" >&3
kill -TERM "$OLD_PID"
deadline=$((SECONDS + 30))
while kill -0 "$OLD_PID" 2>/dev/null; do
  if (( SECONDS >= deadline )); then
    echo 'Shutdown timeout; no force-kill and no second process started' >&3
    exit 1
  fi
  sleep 0.1
done
[ ! -e "$WORKING_DIR/durable/owner.lock" ]
port_status=0
lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN -t > /dev/null || port_status=$?
case "$port_status" in
  0) echo 'Port still occupied; refusing startup' >&3; exit 1 ;;
  1) ;; # No listener.
  *) echo 'Cannot verify port ownership; refusing startup' >&3; exit 1 ;;
esac
printf '%s old process exited; ownership released\n' "$(date -u +%FT%TZ)" >&3
printf '%s\n' "$$" > "$DEPLOY_DIR/new.pid"
exec 3>&-
exec "$NODE" --use-env-proxy --experimental-strip-types src/cli.ts serve >> "$LOG_FILE" 2>&1
