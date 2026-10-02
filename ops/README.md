# Immutable active/passive deployment

pi-imessage must not run two active Messages workers: both could read the same
chat.db rows and send duplicate replies. Deployment therefore uses an
active/passive blue-green handoff.

## Layout

- `~/.pi/imessage/releases/pi-imessage-<version>-<sha>-<timestamp>/`: immutable builds
- `~/.pi/imessage/releases/current`: release used by launchd
- `~/.pi/imessage/releases/previous`: rollback target
- `~/.pi/imessage/deploy.lock`: prevents watchdog interference

The global npm package and the Git working tree are not runtime targets.

## Deployment flow

1. Require a clean, committed Git tree.
2. Export `HEAD` into a new immutable release.
3. Run `npm ci`, check, tests, build, and production audit.
4. Start green on port 7751 with `WORKER_ENABLED=false`.
5. Require `/health/runtime` and a real `/health/model` response of exactly `OK`.
6. Stop green and wait for the active worker's prompts to drain.
7. Atomically update `previous` and `current`, then restart the single worker.
8. Repeat runtime and real-LLM checks; roll back on failure.

Deployment preserves the actual running Node executable, not a Homebrew alias
that may now point elsewhere. `service_runtime.py` validates and pins that
physical path plus its private library/PATH configuration in launchd. The first
pin reloads the LaunchAgent only after shadow validation and idle drain; later
unchanged configurations use kickstart. Source rollback keeps the same validated
runtime pin. The installer refuses loaded-runtime configuration changes that
must instead pass the guarded handoff. Original plists are privately backed up.

## Running from the agent

Do not run the main deploy script synchronously from an active prompt: it waits
for active prompts to drain. After committing, queue it so the current reply can
finish first:

```bash
DEPLOY_CHAT_GUID='iMessage;-;+...' ops/deploy-detached.sh
```

Before detaching, the wrapper atomically registers a `deploy-*.status.json`
receipt beside its log. It transitions through `queued` and `running` to
`completed` only after the blue-green script exits successfully (including its
post-switch probes), or `failed` after repair is attempted. Inspect the explicit
status and exit code; the existence of a log/marker is never success evidence.

Manual deployment outside the agent can call `ops/deploy-blue-green.sh`
directly.

Dependency locks are generated with npm 12, which ignores dependency-published
shrinkwraps; otherwise the SDK's shrinkwrap defeats the security override for
`brace-expansion`. The committed lock is compatible with production npm 10
`npm ci`. Keep the production audit gate enabled. The three Pi SDK packages
move together, and the service requires Node.js >=22.22.0. The minimum is exercised
in CI and on claw with the actual installed extensions. Runtime upgrades are a
separate rollout: assess compatibility and Messages Automation authorization,
retain the old executable and rollback version, and never remove a running
Homebrew keg. A missing live executable fails closed instead of selecting a newer
Node. `/health/runtime` reports `nodeExecutable` and `nodeVersion`; both shadow
and post-switch gates check the selected physical executable.

## Remote review and automatic deployment

Install the polling LaunchAgent once:

```bash
ops/install-remote-review-launchd.sh
```

It checks `origin/main` every 60 seconds. Each unseen commit is fetched into a
detached worktree and reviewed by a read-only Pi session before any dependency
or project script runs. Only an exact `VERDICT: APPROVE` continues. Approved
commits deploy directly from the reviewed detached checkout through the normal
blue-green flow, which repeats checks, tests, audit, shadow startup, and real LLM probes.
Rejected, oversized, rewritten, or failed candidates are not deployed and are
reported to the configured iMessage chat. Runtime state and full reviews live
under `~/.pi/imessage/remote-review/`.

## Watchdog

`ops/pi-imessage-watchdog.sh`:

- ignores a live deployment lock;
- detects stuck prompts from `/health/runtime.lastAgentActivityAt`;
- only restarts or rolls back immutable releases;
- never edits source or dependencies;
- performs a real LLM probe every 15 minutes, but does not restart a healthy
  local worker for an upstream model outage.
