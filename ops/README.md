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

The first deployment automatically replaces the legacy launchd configuration
with `ops/install-launchd.sh`. Later deployments only move the immutable
symlink and kickstart the service.

## Running from the agent

Do not run the main deploy script synchronously from an active prompt: it waits
for active prompts to drain. After committing, queue it so the current reply can
finish first:

```bash
DEPLOY_CHAT_GUID='iMessage;-;+...' ops/deploy-detached.sh
```

Manual deployment outside the agent can call `ops/deploy-blue-green.sh`
directly.

## Watchdog

`ops/pi-imessage-watchdog.sh`:

- ignores a live deployment lock;
- detects stuck prompts from `/health/runtime.lastAgentActivityAt`;
- only restarts or rolls back immutable releases;
- never edits source or dependencies;
- performs a real LLM probe every 15 minutes, but does not restart a healthy
  local worker for an upstream model outage.
