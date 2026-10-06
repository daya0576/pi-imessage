# Operations: installation, deployment and restart

The owner has authorized deployment after each completed change, including
verification, plus committing and pushing each completed intended project change
after the required checks. Do not ask again for routine deployment or commit/push
approval in that scope. Stage explicit intended paths; exclude unrelated drafts,
temporary files and credentials. Verify the pushed remote revision; stop on a
rejected push, never force push. This does not authorize paid probes, test messages,
data cleanup or unrelated service changes. Stop for a new material safety or
data-integrity risk.
Never run old/new pipelines concurrently or use production data in tests.
Implementation readiness and open decisions are tracked in GitHub #33.

For ordinary updates, use [Routine deployment and restart](#routine-deployment-and-restart).
For the first migration from the legacy service, use the separate
[cutover and migration rollback guide](CUTOVER.md). Do not rerun it for ordinary updates.

## Prerequisites

- macOS, Node >=22.22.2, Python 3 and authenticated Pi models.
- Terminal/Node Full Disk Access for Messages' SQLite database; Automation and
  Accessibility permissions for Messages.app/rich-text sends; `/usr/bin/sips`.
- The existing memory CLI at `WORKING_DIR/skills/file-memory/memory_cli.py`.
- The installed `pi-browser` CLI and its pinned Playwright runtime. Run
  `pi-browser setup` when needed and authorized; preflight never installs it. Preflight
  resolves the wrapper in Pi's agent `bin/`, or a preflight-only
  `PI_BROWSER_CLI_PATH` override, and runs `--version` with temporary browser state
  that is removed afterward. A wrapper whose `doctor` reports MISSING is not ready.
  Version readiness does not prove browser privacy, login or per-chat isolation.
- Reviewed native SQLite and image dependencies. Install dependencies with
  `npm ci --ignore-scripts`; if native binaries are missing, review and approve
  their build/download separately rather than silently enabling install scripts.

Safe local checks (no live models/messages/workspace):

```sh
npm run check
npm test
node --experimental-strip-types ops/preflight.mjs
node --experimental-strip-types src/cli.ts --help
```

`WORKING_DIR`, `WEB_HOST`, `WEB_PORT`, `WEB_ENABLED` and `MESSAGES_DB_PATH`
are explicit host configuration. `npm start`, the
executable CLI and the generated launchd job enable Node's environment proxy
support. `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lowercase forms) and
`NODE_OPTIONS` are retained when generating the job; review them before install.
CLI execution loads the current directory's `.env` using Node's parser; existing
environment values take precedence and a missing file is allowed. Set
`DOTENV_CONFIG_PATH` for another file. Module imports and `--help` do not load it.
Other read errors stop startup without printing file contents. `.env` is trusted
operator configuration, not a message attachment. Keep it private and out of Git.
Installation pins its current directory as the job's working directory, so the
same configuration path is used at launch. Selected environment values in the
plist are a snapshot; regenerate a reviewed job to change those overrides.
The job also pins the selected Pi agent directory as an absolute
`PI_CODING_AGENT_DIR` (including the default). Relative paths and `~` are resolved
at installation, after `.env` loading, so daemon HOME/cwd changes do not select a
different auth.json, models.json, settings.json or skill root. This selects a
configuration location; it does not copy credentials or grant access to it.

No proxy credentials are printed by installation. Application startup configures
one process-owned Undici transport after `.env` loading and before model/auth
refresh. Global Pi `httpProxy` supplies HTTP/HTTPS defaults; explicit environment
values win, lowercase proxy/bypass values take precedence, and `NO_PROXY` is
honored. Project-local `httpProxy` is ignored. `/reload` applies changed settings
for subsequent requests while old clients drain active requests. Shutdown stops
messaging and Harness work before releasing owned HTTP resources. Standalone
callers with injected runtimes retain transport control; deliberate fetch
overrides and dispatchers owned by other callers are not replaced on cleanup.

Pi settings in the agent directory and `WORKING_DIR/.pi/settings.json` supply
request policy; `/reload` refreshes it. `retry.provider.timeoutMs` overrides the
provider request timeout, otherwise `httpIdleTimeoutMs` supplies that default
(300000 ms; 0 uses Pi's effectively unlimited value). This forwards a request
option to supporting providers. Separately, application HTTP transport uses
`httpIdleTimeoutMs` for native header/body inactivity timers; 0 disables those
timers. An explicit provider request timeout can still limit a request when
socket-idle timers are disabled. Provider retry limits/delay caps and `retry`
generation policy are executed by Pi/Durable; transport remains SSE. These do
not replace the old host activity timer, prompt maximum-duration or
compaction-deadline behavior.

Web defaults to localhost:7750 and has no authentication. Never expose it to
untrusted networks.

Lifecycle logs use ISO timestamps on stdout/stderr: application startup (PID,
Node version and workspace), agent readiness/reload, the actual Web bind address
or disabled state, messaging readiness (cursor and poll/compaction intervals),
shutdown signal, resource cleanup and failures. Readiness is logged only after
the corresponding initialization succeeds; it is not a model or delivery health
check. Idle polls do not produce log lines. These lifecycle entries do not include
message text, tool arguments or proxy/auth configuration.
The generated launchd job redirects both streams to `WORKING_DIR/service.log`.
Foreground runs use the terminal or the controller's selected redirection; the
application does not open a second log file.

## Workspace migration and service identity

Personal business code and system-summary policy use [workspace extensions](../docs/workspace-extensions.md).
For an existing deployment, prepare source/configuration rollback copies, then
perform the offline configuration migration only after the owning service is
idle, stopped and its lock released:

```sh
node ops/migrate-workspace-extensions.mjs --apply "$WORKING_DIR"
```

Continue the same routine handover below, using the same workspace and receipts.
Do not run this as a test against production or open an extra Harness. The script
backs up configuration and extensions, preserves legacy settings, and never
rewrites Durable files. The next owning startup attaches business task definitions
and performs native checkpoint migration. Retain all backups; rollback must keep
post-migration state and reconcile schema compatibility, not restore old receipts.

New `install` output uses `org.pi-imessage.service` and
`org.pi-imessage.service.plist`. For an installed
`me.changchen.pi-imessage-durable` job, privately preserve its plist/environment,
gracefully stop and unload that exact controller, verify PID/lock/port release,
then write and load the reviewed neutral job. Do not leave the old KeepAlive
controller loaded or start a Terminal copy alongside launchd. A foreground
Terminal service with no old-label job needs no controller change. Never rename
unrelated legacy jobs as part of this migration.

## Routine deployment and restart

### Choose the smallest operation

| Change | Deployment action |
|---|---|
| Server, agent, transport or imported TypeScript modules | Restart the one owning service; verify the changed behavior. |
| Web `app.js` / `style.css` only | Verify the served assets and refresh the browser. The existing file cache checks file metadata; no process restart is needed. |
| Documentation only | Update the source checkout and check the diff. No runtime reload or restart is needed. |
| Configuration supported by `/reload` | Use the documented reload path; restart only for startup-only configuration. Do not manufacture an iMessage to trigger it. |
| First legacy-to-Durable migration | Follow [CUTOVER.md](CUTOVER.md). Do not rerun the importer against the existing workspace. |

Deploying means the intended change is available and verified. It does not mean
restarting an unchanged process. Delivery also includes committing and pushing
the intended changes under the owner's standing authorization. HEAD alone does
not identify a dirty deployment.

### Release directories

The service runs a fixed commit, never the main checkout, so merged or
half-edited files do not go live on the next restart.

```sh
SHA=$(git -C /Users/clawbot/pi-imessage-next rev-parse HEAD)
RELEASE=/Users/clawbot/pi-imessage-releases/$SHA
git -C /Users/clawbot/pi-imessage-next worktree add --detach "$RELEASE" "$SHA"
(cd "$RELEASE" && npm ci --ignore-scripts)
```

- The controller starts the new process from `$RELEASE`; `WORKING_DIR` and the
  agent directory do not change.
- Never edit a release directory. Rollback is a routine restart from the
  previous one.
- Keep the latest three. Remove an older one with `git worktree remove` (no
  `--force`) only when no process or launchd plist uses it.
- The main checkout is only for merging. The first restart under this rule
  moves the service out of it.

### 1. Identify once; retain the evidence

```sh
cd /Users/clawbot/pi-imessage-next
git rev-parse HEAD
git status --short
launchctl list | grep -Ei 'pi-imessage|pi-web' || true
lsof -nP -iTCP:7750 -sTCP:LISTEN
# Set PID from the listener, never from this document or a previous deployment.
ps -p "$PID" -o pid,ppid,lstart,command
lsof -a -p "$PID" -d cwd,txt,1,2 -Fn
```

Identify the controller, executable, source directory, startup time, selected
workspace/agent directory and actual log destinations. A similarly named Pi web
job is not evidence that it controls this service. Do not stop unrelated jobs.

The verified claw baseline is a **Terminal foreground process**, not a loaded
Durable launchd job. It uses `/Users/clawbot/pi-imessage-next`, the selected Node
22 executable, `~/.pi/imessage-next`, and `~/.pi/agent`. Its current log destination
is `WORKING_DIR/service.log`, resolving through the workspace symlink. These are
starting hints, not substitutes for the commands above. Preserve the configured
bind; the owner-selected `0.0.0.0:7750` is unauthenticated and for trusted networks
only. Do not switch controllers, install launchd, or upgrade Node as part of a
routine restart.

Read `/chat/data` for **counts** of `inspection.tasks` and
`inspection.submissions`. Prefer an idle restart. Native `imessage.schedule`
background tasks in a `sleep` checkpoint with a future deadline are expected;
they do not block restart and their checkpoints must be retained. Active
occurrences, generations, tools, queued submissions or an imminent scheduler
wake still defer the stop. If new work appears before stopping, defer and
recheck; do not abort it merely to deploy. Inspect relevant
reply/send receipts and record counts of `sending` / `unknown`, without dumping
chat text. Existing unknown receipts do not require resending or block an idle
restart. Never reset cursors, delete state or replay uncertain effects.

### 2. Check only what changed

For code, run `npm run check` and the affected test files. Before a commit, run
full `npm test` as required by `AGENTS.md`. Reuse passing results for the same
source; do not rerun the full suite after an unchanged read-only inspection.
Run the safe preflight for a new Node/dependency/permission environment, or an
unverified fresh launch. Reuse it when that environment is unchanged. Keep full
check output. Do not use `/health/model` as a startup probe: it is a paid request.

Record changed-source hashes or an equivalent source fingerprint alongside HEAD
and dirty paths. Recheck the fingerprint and service identity immediately before
stopping. Unrelated drafts must remain intact. If they introduce a new runtime
risk, resolve that scope before deploying the whole checkout.

### 3. Prepare one private, independent controller

Create a private directory with `mktemp -d /tmp/pi-imessage-restart.XXXXXX` and
`umask 077`. Prepare **all** files before opening the controller:

- `environment.sh`: shell-quoted exports of the selected process environment
  overrides. Capture in memory or directly into a mode-600 file; never print
  `ps eww`, credentials, complete plists or the full environment to tool output.
  Preserve `WORKING_DIR`, `PI_CODING_AGENT_DIR`, `DOTENV_CONFIG_PATH`, Web/DB
  overrides, proxy/bypass variables (both cases), `NODE_OPTIONS`, search keys,
  HOME/locale, `TZ` and PATH. Read cwd `.env` only to resolve values not overridden by
  the running process. Retain `~/.pi/agent/bin` and the selected Node directory in
  PATH; do not silently substitute the tool runner's environment.
- `control.sh`: shell-quoted values for `OLD_PID`, `OLD_STARTED` (exact `ps`
  startup-time output), `EXPECTED_COMMAND`, `REPO`, `NODE`, `WORKING_DIR`,
  `WEB_PORT`, `LOG_FILE` and `DEPLOY_DIR`, all resolved from step 1.
- `restart.command`: the following one-shot controller. Compare the prepared
  source fingerprint and idle-work counts before launching it. Do not edit a
  controller while it runs.

```sh
#!/bin/bash
set -euo pipefail
umask 077
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/environment.sh"
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
```

For the verified Terminal controller, launch through the normal application
launcher:

```sh
chmod 700 "$DEPLOY_DIR/restart.command"
open -a Terminal "$DEPLOY_DIR/restart.command"
```

This path succeeded on claw; `osascript` with Terminal `do script` timed out.
Use `open` first, rather than rediscovering the AppleScript path. This is not
permission to bypass macOS privacy/security prompts. Stop on a permission denial.
The independent Terminal also avoids killing the initiating agent's own turn.

If the actual controller is launchd instead, use that identified job's lifecycle
and preserve its reviewed configuration; do not launch a Terminal copy alongside
it. A loaded KeepAlive job can respawn after a bare PID kill. Never use legacy
blue-green scripts or `launchctl kickstart -k` from inside the service-owned agent.

### 4. Verify the result, not the invocation

A timeout or disconnected tool does not prove the controller failed. Read
`controller.log`, `new.pid`, the selected service log and the listener first.
**Do not launch the controller a second time** until the first outcome is known.

Require:

1. Old PID absent; owner lock released during the handover; exactly one new
   service/listener with the expected executable, cwd, configuration and PATH.
   A new owner lock after startup is normal.
2. Fresh `Application starting`, `Agent ready`, `Web server listening`,
   `Messaging ready` and `Application started` records; no startup failure.
3. Root HTTP 200 and a read-only check of the changed API/assets. For UI work,
   verify the changed behavior in the browser, not just the page's status code.
4. Pending/uncertain receipt state preserved without manual replay. Use existing
   continuation evidence if available; do not initiate a model call or send a
   test message without separate authorization. Report that verification limit.

On a remaining lock, occupied port, shutdown timeout or startup failure, stop and
report the specific blocker. Keep state and logs intact. Do not force-kill,
steal the lock, reinstall dependencies or restore a workspace snapshot to make
readiness appear successful. Inspect the failure before attempting a controlled
recovery with the same state and correct startup configuration.

Record deployment time, source fingerprint (including dirty state), new PID,
checks and unverified limits in structured memory via `pi-memory`. Service logs
retain the lifecycle evidence. Remove completed ad-hoc controller scripts and
private environment snapshots from `/tmp`; retain any needed sanitized receipt.
Then report **deployed and verified**, or the concrete blocker. Do not stop at
"tests passed" or "rule remembered" when runtime deployment is still required.

All release gates, unresolved behavior decisions and verification evidence live
in GitHub #33. This document is an operating procedure, not a completion claim.
