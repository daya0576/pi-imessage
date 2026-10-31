# Operations: deployment and restart

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
The one-time legacy migration is archived at tag `archive/legacy-migration`.

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
| Documentation only | Commit and push `next`; no reload or restart. |
| Configuration supported by `/reload` | Reload; restart only for startup-only configuration. Never send an iMessage to trigger it. |

Deploying means the change is live and verified, then committed and pushed.

### Release directories

The service runs a fixed, pushed `next` commit, never the main
checkout or a conversation worktree:

```sh
git -C /Users/clawbot/pi-imessage-next fetch -q origin next
SHA=$(git -C /Users/clawbot/pi-imessage-next rev-parse origin/next)
RELEASE=/Users/clawbot/pi-imessage-releases/$SHA
git -C /Users/clawbot/pi-imessage-next worktree add --detach "$RELEASE" "$SHA"
(cd "$RELEASE" && npm ci --ignore-scripts && node --experimental-strip-types src/cli.ts preflight)
```

Never edit a release directory; rollback is a routine restart from the previous
one or from a release of `origin/main`. Keep the latest three; remove older ones with `git worktree remove` (no
`--force`) when no process or plist uses them. A release directory has no `.env`:
set `DOTENV_CONFIG_PATH` to the main checkout's `.env`.

### Cutting pull requests (owner)

`main` changes only through pull requests cut from `next` commits:

```sh
ops/cut-pr.sh <branch-name> <sha>...
```

This branches from `origin/main` in a new worktree, cherry-picks the commits
in the given order, pushes and opens the pull request. A conflict stops before
the push; resolve it in the worktree or pick the commit the change depends on.
After a merge, a conversation replays `next` onto `origin/main` (AGENTS.md,
Git) so that `next` is always `main` plus the unmerged commits.

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

### 2. Record the baseline

Restart at any time; no running work defers it. Before stopping, record the
counts of `sending` / `unknown` receipts from `/chat/data` (counts only, no chat
text). Never reset cursors, delete state or replay uncertain sends. Do not use
`/health/model`: it is a paid request.

### 3. Run one private controller

From a chat, the assistant calls `restart_service` with the full commit hash of
the prepared release directory. The host writes the controller
directory below itself and opens the controller only after that tool call has
settled; the call returns the directory and the next call verifies (step 4).
The manual procedure below is for operators and for a cold start when no
service is running.

In a `mktemp -d /tmp/pi-imessage-restart.XXXXXX` directory with `umask 077`:

- `environment.sh`: shell-quoted exports of the running process's `WORKING_DIR`,
  `PI_CODING_AGENT_DIR`, `DOTENV_CONFIG_PATH`, Web/DB overrides, proxy variables
  (both cases), `NODE_OPTIONS`, search keys, HOME, locale, `TZ` and PATH (keep
  `~/.pi/agent/bin` and the Node directory). Write it directly; never print
  values, `ps eww` output or credentials.
- `control.sh`: shell-quoted `OLD_PID`, `OLD_STARTED` (exact `ps -o lstart=`),
  `EXPECTED_COMMAND`, `REPO` (the release directory), `NODE`, `WORKING_DIR`,
  `WEB_PORT` and `LOG_FILE`.
- `restart.command`: a copy of [`ops/restart.command`](restart.command) from the
  release directory. It checks the old PID's start time and command, sends
  SIGTERM, waits up to 30 s, refuses to start while the lock or port is held,
  writes `controller.log` and `new.pid`, deletes `environment.sh` and then
  `exec`s the new service process.

Launch it once with `chmod 700` and `open -a Terminal "$DEPLOY_DIR/restart.command"`
(`osascript` `do script` times out on claw). The separate Terminal keeps the
controller alive when the initiating agent's own turn is interrupted. For a
launchd controller, use that job's lifecycle instead; never `launchctl kickstart -k`
from inside the service.

A chat that writes its own controller through `bash` instead of
`restart_service` must end that call right after `open`: no `sleep`, polling or
verification in the same call. Tools are replay-safe by default, so a
call still running when the controller stops the service reruns on every start,
launches another controller and loops (#39). Verify in a later call.

### 4. Verify

In a new tool call, read `controller.log`, `new.pid`, the service log and the
listener first. Never launch the controller twice before the first outcome is
known. Require:

1. Old PID gone; exactly one new process and listener, cwd in the release
   directory.
2. Fresh `Application starting`, `Agent ready`, `Web server listening`,
   `Messaging ready` and `Application started`; no startup error.
3. Root and changed endpoints return 200; check UI changes in a browser.
4. Interrupted work continues; scheduler deadlines are unchanged; receipt
   counts change only by new sends and sends interrupted by the stop. After
   `restart_service`, the old log shows `Restart requested` with the
   controller directory.

On a timeout, lock, occupied port or startup failure, stop and report it. Do not
force-kill, steal the lock, reinstall dependencies or restore a workspace snapshot.

Routine deployments do not run the live smoke. Only when the owner authorizes a
paid model request and a real message, run
`node --experimental-strip-types scripts/smoke.ts --live --chat CHAT_GUID`: it checks
`/health/model`, waits for the operator's message from the device and reports
the new reply's receipt. Never resend a reply that is not `sent`.
Record the deployment (time, commit, PID, checks, unverified limits) with
`pi-memory`, delete the `/tmp` controller directory, and report **deployed and
verified** or the blocker. Release gates and evidence live in GitHub #33.
