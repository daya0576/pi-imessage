# 0009. Switch over in one step

Status: proposed (2026-10-04)

**Context.** Running old and new pipelines side by side (a per-chat canary) needs guards against processing a message twice. That was much of #31's complexity.

**Decision.** Build in a new repository, `pi-imessage-next`. At cutover: stop the old service, run the migration (which also saves the current `chat.db` row as the watch cursor), start the new service, then push the new code to `daya0576/pi-imessage` as one commit. Rollback: stop the new service, restore the `WORKING_DIR` backup, start the old release.

**Consequences.** Minutes of downtime; messages that arrive meanwhile are picked up from the cursor, and losing a few is acceptable. No code for running two pipelines.

**Rejected.** Per-chat canary.
