#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
LABEL="com.kingcrab.pi-imessage.remote-review"
DOMAIN="gui/$(id -u)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
CHAT_GUID="${REMOTE_REVIEW_CHAT_GUID:-iMessage;-;+8617612150403}"

mkdir -p "${HOME}/Library/LaunchAgents" "${IMESSAGE_DIR}/remote-review"
chmod +x "${REPO_ROOT}/ops/remote-review-deploy.sh"

cat >"${PLIST}.new" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>${REPO_ROOT}/ops/remote-review-deploy.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>IMESSAGE_DIR</key><string>${IMESSAGE_DIR}</string>
    <key>REMOTE_REVIEW_CHAT_GUID</key><string>${CHAT_GUID}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${IMESSAGE_DIR}/remote-review/stdout.log</string>
  <key>StandardErrorPath</key><string>${IMESSAGE_DIR}/remote-review/stderr.log</string>
</dict></plist>
PLIST

plutil -lint "${PLIST}.new" >/dev/null
mv "${PLIST}.new" "${PLIST}"
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "${DOMAIN}" "${PLIST}"
echo "Installed ${LABEL}; origin/main is checked every 60 seconds."
