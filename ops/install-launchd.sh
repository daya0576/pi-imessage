#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
RELEASE_ROOT="${RELEASE_ROOT:-${IMESSAGE_DIR}/releases}"
CURRENT_LINK="${RELEASE_ROOT}/current"
LABEL="com.kingcrab.pi-imessage"
WATCHDOG_LABEL="com.kingcrab.pi-imessage.watchdog"
DOMAIN="gui/$(id -u)"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
SERVICE_PLIST="${LAUNCH_DIR}/${LABEL}.plist"
WATCHDOG_PLIST="${LAUNCH_DIR}/${WATCHDOG_LABEL}.plist"

[[ -x "${CURRENT_LINK}/dist/main.js" || -f "${CURRENT_LINK}/dist/main.js" ]] || {
  echo "Missing built immutable release at ${CURRENT_LINK}" >&2
  exit 1
}
mkdir -p "${LAUNCH_DIR}" "${IMESSAGE_DIR}/logs" "${IMESSAGE_DIR}/watchdog"

cat >"${SERVICE_PLIST}.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>${CURRENT_LINK}/dist/main.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WEB_ENABLED</key><string>true</string>
    <key>WEB_HOST</key><string>0.0.0.0</string>
    <key>WEB_PORT</key><string>7750</string>
    <key>WORKER_ENABLED</key><string>true</string>
    <key>WORKING_DIR</key><string>${IMESSAGE_DIR}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${IMESSAGE_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>${IMESSAGE_DIR}/logs/stderr.log</string>
</dict></plist>
PLIST
plutil -lint "${SERVICE_PLIST}.new" >/dev/null
mv "${SERVICE_PLIST}.new" "${SERVICE_PLIST}"

cat >"${WATCHDOG_PLIST}.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>${CURRENT_LINK}/ops/pi-imessage-watchdog.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${IMESSAGE_DIR}/watchdog/launchd.stdout.log</string>
  <key>StandardErrorPath</key><string>${IMESSAGE_DIR}/watchdog/launchd.stderr.log</string>
</dict></plist>
PLIST
plutil -lint "${WATCHDOG_PLIST}.new" >/dev/null
mv "${WATCHDOG_PLIST}.new" "${WATCHDOG_PLIST}"

launchctl bootout "${DOMAIN}/${WATCHDOG_LABEL}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "${DOMAIN}" "${SERVICE_PLIST}"
launchctl bootstrap "${DOMAIN}" "${WATCHDOG_PLIST}"

for _ in $(seq 1 60); do
  if curl -fsS --max-time 3 http://127.0.0.1:7750/health/runtime >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:7750/health/runtime >/dev/null
curl -fsS --max-time 45 http://127.0.0.1:7750/health/model \
  | /usr/bin/python3 -c 'import json,sys; data=json.load(sys.stdin); assert data.get("ok") is True'
echo "LaunchAgents installed; runtime and real LLM health checks passed."
