# Operator installation and cutover

No deployment is authorized by development commits. Do not restart a running
service from inside the agent, run both old/new pipelines, or use production data
in tests. Implementation readiness and open decisions are tracked in GitHub #33.

## Prerequisites

- macOS, Node >=22.22.2, Python 3 and authenticated Pi models.
- Terminal/Node Full Disk Access for Messages' SQLite database; Automation and
  Accessibility permissions for Messages.app/rich-text sends; `/usr/bin/sips`.
- The existing memory CLI at `WORKING_DIR/skills/file-memory/memory_cli.py`.
- The installed shared scheduler `service.cjs` and `time.cjs` (API version 1),
  normally in Pi's agent directory under `extensions/scheduler/`. Override the
  entry path with `PI_SCHEDULER_SERVICE_PATH`; no scheduler source is vendored.
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

`WORKING_DIR`, `WEB_HOST`, `WEB_PORT`, `WEB_ENABLED`, `MESSAGES_DB_PATH` and
`PI_SCHEDULER_SERVICE_PATH` are explicit host configuration. `npm start`, the
executable CLI and the generated launchd job enable Node's environment proxy
support. `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and their lowercase forms) and
`NODE_OPTIONS` are retained when generating the job; review them before install.
No proxy credentials are printed by installation. If invoking Node directly for
`serve`, include `--use-env-proxy`. This does not implement Pi's separate
`httpProxy` setting or the old host activity/duration timeout policy.

Pi settings in the agent directory and `WORKING_DIR/.pi/settings.json` supply
request policy; `/reload` refreshes it. `retry.provider.timeoutMs` overrides the
provider request timeout, otherwise `httpIdleTimeoutMs` supplies that default
(300000 ms; 0 uses Pi's effectively unlimited value). This forwards a request
option to supporting providers, not a socket-inactivity timer. Provider retry
limits/delay caps and `retry` generation policy are executed by Pi/Durable;
transport remains SSE. These do not replace the old host inactivity, prompt
maximum-duration or compaction-deadline behavior.

Web defaults to localhost:7750 and has no authentication. Never expose it to
untrusted networks.

## Authorized one-shot cutover

Only proceed after explicit authorization, accepted behavior decisions, and all
required capabilities/remaining gaps in #33 have been verified.

1. Record the exact Git revision. Stop the old service yourself and confirm no
   old workers are running. Do not delete SDK/session/goal/scratch files yet.
2. Capture `MAX(ROWID)` from the intended Messages database after the old service
   stops and before the backup/import window. Record the value and timestamp.
   Inspect pending old work and uncertain sends; do not assume they are undone.
3. Resolve workspace symlinks and external/missing attachment paths explicitly.
   Use separate source, new target and new backup directories, never nested.
4. Run the offline importer. It copies/verifies SHA-256 backups before staging,
   preserves settings/memory/cron/reminder data, imports history/attachment paths,
   appends empty-context resets and sets delivery scans/cursor. It never infers or
   sends. It refuses an existing target and never deletes source or backup:

   ```sh
   node --experimental-strip-types src/cli.ts import \
     --source OLD_WORKSPACE --target NEW_WORKSPACE \
     --backup VERIFIED_BACKUP --cursor RECORDED_ROWID
   ```

5. Inspect `backup-manifest.json` and `import-receipt.json`; rehearse restoration
   from the backup. Retain old SDK artifacts until a separate cleanup approval.
6. Set `WORKING_DIR` to the imported target. Start the new service yourself,
   initially in foreground (`npm start`).
   A brand-new, unimported workspace intentionally skips existing Messages rows.
7. Run the explicitly live smoke only after approval:

   ```sh
   node --experimental-strip-types ops/smoke.ts --live --chat CHAT_GUID
   ```

   This makes a paid model request and sends a real message. Confirm DM/group/SMS,
   HEIC images, text/rich-text/files, native tools, model/thinking/reload, run/stop,
   reminders/cron, background summaries, isolated prompts and read-only web views.
   Check sender permissions/focus and receipt states. Faux tests are not evidence
   of real-model judgment or actual recipient delivery.
8. `WORKING_DIR=NEW_WORKSPACE node --experimental-strip-types src/cli.ts install`
   writes a new launchd plist exclusively; it does not load or restart anything.
   After stopping the foreground process yourself, inspect that plist and use
   `launchctl bootstrap gui/$(id -u) PLIST_PATH` yourself. Never load alongside
   the old job. Record its PID, revision and successful checks.

## Rollback

Stop the new service yourself; preserve the new workspace and all post-cutover
send receipts, source cursor and scheduler databases. Reconcile messages and
scheduled sends since cutover before restoring the verified backup and starting
the old release. A pre-cutover backup alone does not account for later sends;
blind restoration/replay can duplicate effects. Treat `sending`/`unknown` as
uncertain, verify independently and use a fresh explicit send ID only when a
human deliberately resends. Do not force-push or delete the new data to roll back.

All release gates, unresolved behavior decisions and verification evidence live
in GitHub #33. This document is an operator procedure, not a completion claim.
