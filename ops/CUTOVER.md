# First legacy-to-Durable cutover

This is a one-time migration from the legacy service, not a routine update.
Never run the importer against an existing Durable workspace. For ordinary
updates, follow [Routine deployment and restart](README.md#routine-deployment-and-restart).

Read the shared [prerequisites and configuration](README.md#prerequisites) before
starting. This guide does not grant permission for live test messages, paid model
probes or data cleanup beyond the owner's explicit migration request.

## Authorized one-shot cutover

Use the user's explicit request as authorization for its stated scope. Check
prerequisites relevant to that operation and report concrete blockers or unverified
limits; do not demand blanket issue completion or repeat approval for the same
operation. Live test messages, unrelated task activation and data cleanup must
remain within the authorized scope.

1. Record the exact Git revision. Stop the old service and confirm no
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

5. Review independent legacy producers using `crontab -l`, launchd and scoped
   searches of the legacy skills/scripts. Stop competing message producers
   before cutover. Do not import them as producers: legacy cron,
   reminders, arbitrary delayed prompts, background summaries and PT Automation
   remain removed under ADR 0019. ADR 0032 separately authorizes native background
   compaction and the explicitly configured daily English job; it is not an
   importer for legacy job definitions. Retained job data is inert here; removing source code
   does not stop OS jobs or uninstall shared Pi extensions. Retired HTTP callers
   get 404, not a scheduler adapter.
6. Inspect `backup-manifest.json` and `import-receipt.json`; rehearse restoration
   from the backup. Retain old SDK artifacts until a separate cleanup approval.
7. Set `WORKING_DIR` to the imported target. Start the new service,
   initially in foreground (`npm start`).
   A brand-new, unimported workspace intentionally skips existing Messages rows.
8. Run the live smoke when the authorized scope includes live model/message testing:

   ```sh
   node --experimental-strip-types ops/smoke.ts --live --chat CHAT_GUID
   ```

   This makes a paid model request and sends a real message. Confirm DM/group/SMS,
   HEIC images, text/rich-text/files, native tools, model/thinking/reload, run/stop,
   `send_message` and read-only web views. Removed scheduling and PT routes must
   return 404; startup must leave retained task data untouched.
   Check sender permissions/focus and receipt states. Faux tests are not evidence
   of real-model judgment or actual recipient delivery.
9. `WORKING_DIR=NEW_WORKSPACE node --experimental-strip-types src/cli.ts install`
   writes a new launchd plist exclusively; it does not load or restart anything.
   After stopping the foreground process, inspect that plist and use
   `launchctl bootstrap gui/$(id -u) PLIST_PATH`. Never load alongside
   the old job. Record its PID, revision and successful checks.

## Rollback

Stop the new service; preserve the new workspace and all post-cutover
send receipts, source cursor and any retained task databases. Reconcile messages
and effects from independent system jobs since cutover before restoring the verified backup and starting
the old release. A pre-cutover backup alone does not account for later sends;
blind restoration/replay can duplicate effects. Treat `sending`/`unknown` as
uncertain, verify independently and use a fresh explicit send ID only when a
human deliberately resends. Do not force-push or delete the new data to roll back.

All release gates, unresolved behavior decisions and verification evidence live
in GitHub #33. This document is an operating procedure, not a completion claim.
