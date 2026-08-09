#!/usr/bin/env bash
set -euo pipefail

# Poll origin/main, review each unseen commit with a read-only Pi session, and
# deploy approved updates through the immutable active/passive deployment path.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
IMESSAGE_DIR="${IMESSAGE_DIR:-${HOME}/.pi/imessage}"
STATE_DIR="${IMESSAGE_DIR}/remote-review"
LOCK_DIR="${STATE_DIR}/lock"
DEPLOYED_FILE="${STATE_DIR}/deployed-sha"
ATTEMPT_FILE="${STATE_DIR}/last-attempt-sha"
REVIEW_DIR="${STATE_DIR}/reviews"
LOG_PREFIX="[remote-review]"
CHAT_GUID="${REMOTE_REVIEW_CHAT_GUID:-iMessage;-;+8617612150403}"
ACTIVE_URL="${ACTIVE_URL:-http://127.0.0.1:7750}"
PI_MODEL="${REMOTE_REVIEW_MODEL:-openai-codex/gpt-5.6-sol}"
MAX_PATCH_BYTES="${REMOTE_REVIEW_MAX_PATCH_BYTES:-2000000}"

mkdir -p "${STATE_DIR}" "${REVIEW_DIR}"

log() {
  printf '[%s] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${LOG_PREFIX}" "$*"
}

send_message() {
  local text="$1"
  /usr/bin/curl -fsS --max-time 10 -X POST "${ACTIVE_URL}/send" \
    -H 'Content-Type: application/json' \
    -d "$(/usr/bin/python3 -c 'import json,sys; print(json.dumps({"chatGuid":sys.argv[1],"text":sys.argv[2]}))' "${CHAT_GUID}" "${text}")" \
    >/dev/null 2>&1 || true
}

cleanup() {
  if [[ -n "${WORKTREE:-}" ]]; then
    git -C "${REPO_ROOT}" worktree remove --force "${WORKTREE}" >/dev/null 2>&1 || true
  fi
  rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  exit 0
fi

if ! git -C "${REPO_ROOT}" diff --quiet || ! git -C "${REPO_ROOT}" diff --cached --quiet; then
  log "source repository is dirty; refusing automatic review/deploy"
  exit 0
fi

REMOTE_SHA="$(git -C "${REPO_ROOT}" ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "${REMOTE_SHA}" =~ ^[0-9a-f]{40}$ ]] || { log "could not resolve origin/main"; exit 1; }

LAST_ATTEMPT="$(cat "${ATTEMPT_FILE}" 2>/dev/null || true)"
[[ "${REMOTE_SHA}" != "${LAST_ATTEMPT}" ]] || exit 0

log "new remote commit ${REMOTE_SHA}"
git -C "${REPO_ROOT}" fetch --quiet origin main

BASE_SHA="$(cat "${DEPLOYED_FILE}" 2>/dev/null || true)"
if [[ ! "${BASE_SHA}" =~ ^[0-9a-f]{40}$ ]] || ! git -C "${REPO_ROOT}" cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  BASE_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
fi

# A rewritten remote branch needs an explicit human decision. Automatic
# deployment only accepts commits descending from the known deployed commit.
if ! git -C "${REPO_ROOT}" merge-base --is-ancestor "${BASE_SHA}" "${REMOTE_SHA}"; then
  printf '%s\n' "${REMOTE_SHA}" >"${ATTEMPT_FILE}"
  log "origin/main is not a descendant of deployed ${BASE_SHA}; rejected"
  send_message "发现 pi-imessage remote main 被改写或不是当前部署版本的后继，已停止自动部署：${REMOTE_SHA:0:12}。"
  exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"
WORKTREE="${STATE_DIR}/candidate-${REMOTE_SHA:0:12}-${STAMP}"
PATCH_FILE="${REVIEW_DIR}/${STAMP}-${REMOTE_SHA:0:12}.patch"
REVIEW_FILE="${REVIEW_DIR}/${STAMP}-${REMOTE_SHA:0:12}.txt"

git -C "${REPO_ROOT}" worktree add --quiet --detach "${WORKTREE}" "${REMOTE_SHA}"
git -C "${REPO_ROOT}" diff --no-ext-diff --unified=60 "${BASE_SHA}..${REMOTE_SHA}" >"${PATCH_FILE}"
PATCH_BYTES="$(wc -c <"${PATCH_FILE}" | tr -d ' ')"
printf '%s\n' "${REMOTE_SHA}" >"${ATTEMPT_FILE}"

if (( PATCH_BYTES > MAX_PATCH_BYTES )); then
  log "patch is too large for automatic review: ${PATCH_BYTES} bytes"
  send_message "发现 pi-imessage remote 更新 ${REMOTE_SHA:0:12}，但 diff 有 ${PATCH_BYTES} 字节，超过自动审查上限，未部署。"
  exit 1
fi

send_message "发现 pi-imessage remote 更新 ${REMOTE_SHA:0:12}，正在做只读代码审查；通过后会自动蓝绿部署。"

REVIEW_PROMPT=$(cat <<EOF
Review the attached git patch for pi-imessage. The candidate checkout is ${WORKTREE}.
Base commit: ${BASE_SHA}
Candidate commit: ${REMOTE_SHA}

Use only read-only tools. Inspect changed files and nearby code as needed. Focus on correctness, regressions, data loss, secret exposure, command injection, duplicate iMessage workers, scheduler/reminder duplication, deployment/rollback safety, backward compatibility, and missing tests. Treat high-confidence critical or high-severity issues as blockers. Minor style issues are not blockers.

Give a concise review with findings and reasoning. The final line must be exactly one of:
VERDICT: APPROVE
VERDICT: REJECT
EOF
)

set +e
(
  cd "${WORKTREE}"
  /opt/homebrew/bin/pi --no-session --thinking high --model "${PI_MODEL}" \
    --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve \
    --tools read,grep,find,ls -p "@${PATCH_FILE}" "${REVIEW_PROMPT}"
) >"${REVIEW_FILE}" 2>&1
REVIEW_RC=$?
set -e

if (( REVIEW_RC != 0 )); then
  log "Pi review failed with exit ${REVIEW_RC}"
  send_message "pi-imessage 更新 ${REMOTE_SHA:0:12} 的自动代码审查执行失败，未部署。详情：${REVIEW_FILE}"
  exit 1
fi

if ! grep -qx 'VERDICT: APPROVE' "${REVIEW_FILE}"; then
  log "candidate rejected by review"
  SUMMARY="$(tail -n 12 "${REVIEW_FILE}" | head -c 1800)"
  send_message "pi-imessage 更新 ${REMOTE_SHA:0:12} 未通过自动代码审查，因此没有部署。\n${SUMMARY}"
  exit 1
fi

# Deploy directly from the detached reviewed candidate. The polling checkout may
# contain independent local automation work and does not need to track remote main.
# The deploy script repeats install, static checks, tests, production audit,
# shadow startup, and real LLM checks before and after the active/passive switch.
log "candidate approved; starting blue-green deployment"
if DEPLOY_CHAT_GUID="${CHAT_GUID}" "${WORKTREE}/ops/deploy-blue-green.sh"; then
  printf '%s\n' "${REMOTE_SHA}" >"${DEPLOYED_FILE}"
  log "deployed ${REMOTE_SHA}"
else
  log "deployment failed for ${REMOTE_SHA}"
  send_message "pi-imessage 更新 ${REMOTE_SHA:0:12} 已通过代码审查，但蓝绿部署失败；部署脚本已按规则保留旧版本或回滚。"
  exit 1
fi
