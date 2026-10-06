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
The one-time legacy migration is archived at tag `archive/legacy-migration` (ADR 0043).

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

For changes to the built-in browser, also run
`node --experimental-strip-types ops/browser-smoke.mjs`. This uses real headless
Chrome and the installed pinned CLI with temporary HOME/profiles, loopback pages
and synthetic login state; it never opens a personal profile or sends a message.
See [browser isolation and retention](../docs/browser.md).

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

## Service identity

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

| Change | Action |
|---|---|
| Server, agent, transport or imported TypeScript | Restart from a new release directory; verify the change. |
| Web `app.js` / `style.css` only | Verify the served assets; no restart (the file cache checks metadata). |
| Documentation only | Commit and push; no reload or restart. |
| Configuration supported by `/reload` | Reload; restart only for startup-only configuration. Never send an iMessage to trigger it. |

Deploying means the change is live and verified, then committed and pushed.

### Release directories

The service runs a fixed commit, never the main checkout:

```sh
SHA=$(git -C /Users/clawbot/pi-imessage-next rev-parse origin/main)
RELEASE=/Users/clawbot/pi-imessage-releases/$SHA
git -C /Users/clawbot/pi-imessage-next worktree add --detach "$RELEASE" "$SHA"
(cd "$RELEASE" && npm ci --ignore-scripts && node --experimental-strip-types ops/preflight.mjs)
```

Never edit a release directory; rollback is a routine restart from the previous
one. Keep the latest three; remove older ones with `git worktree remove` (no
`--force`) when no process or plist uses them. A release directory has no `.env`:
set `DOTENV_CONFIG_PATH` to the main checkout's `.env`.

### 1. Identify the running service

```sh
launchctl list | grep -Ei 'pi-imessage|pi-web' || true
lsof -nP -iTCP:7750 -sTCP:LISTEN          # take PID from here, never from notes
ps -p "$PID" -o pid,ppid,lstart,command
lsof -a -p "$PID" -d cwd,1,2 -Fn
```

The claw baseline is a **Terminal foreground process** (not launchd) running from
a release directory, with `WORKING_DIR=~/.pi/imessage-next`,
`PI_CODING_AGENT_DIR=~/.pi/agent`, Node 22, logs in `WORKING_DIR/service.log`, and
the owner-selected unauthenticated bind `0.0.0.0:7750` (trusted networks only).
A similarly named Pi web job does not control this service. Do not switch
controllers, install launchd or upgrade Node during a routine restart.

### 2. Record the baseline (ADR 0038)

Restart at any time; no running work defers it. Before stopping, record the
counts of `sending` / `unknown` receipts from `/chat/data` (counts only, no chat
text). Never reset cursors, delete state or replay uncertain sends. Do not use
`/health/model`: it is a paid request.

### 3. Run one private controller

In a `mktemp -d /tmp/pi-imessage-restart.XXXXXX` directory with `umask 077`:

- `environment.sh`: shell-quoted exports of the running process's `WORKING_DIR`,
  `PI_CODING_AGENT_DIR`, `DOTENV_CONFIG_PATH`, Web/DB overrides, proxy variables
  (both cases), `NODE_OPTIONS`, search keys, HOME, locale, `TZ` and PATH (keep
  `~/.pi/agent/bin` and the Node directory). Write it directly; never print
  values, `ps eww` output or credentials.
- `control.sh`: shell-quoted `OLD_PID`, `OLD_STARTED` (exact `ps -o lstart=`),
  `EXPECTED_COMMAND`, `REPO` (the release directory), `NODE`, `WORKING_DIR`,
  `WEB_PORT` and `LOG_FILE`.
- `restart.command`:

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

Launch it once with `chmod 700` and `open -a Terminal "$DEPLOY_DIR/restart.command"`
(`osascript` `do script` times out on claw). The separate Terminal keeps the
controller alive when the initiating agent's own turn is interrupted. For a
launchd controller, use that job's lifecycle instead; never `launchctl kickstart -k`
from inside the service.

### 4. Verify

Read `controller.log`, `new.pid`, the service log and the listener first. Never
launch the controller twice before the first outcome is known. Require:

1. Old PID gone; exactly one new process and listener, cwd in the release
   directory.
2. Fresh `Application starting`, `Agent ready`, `Web server listening`,
   `Messaging ready` and `Application started`; no startup error.
3. Root and changed endpoints return 200; check UI changes in a browser.
4. Interrupted work continues; scheduler deadlines are unchanged; receipt
   counts change only by new sends and sends interrupted by the stop.

On a timeout, lock, occupied port or startup failure, stop and report it. Do not
force-kill, steal the lock, reinstall dependencies or restore a workspace snapshot.
Record the deployment (time, commit, PID, checks, unverified limits) with
`pi-memory`, delete the `/tmp` controller directory, and report **deployed and
verified** or the blocker. Release gates and evidence live in GitHub #33.
