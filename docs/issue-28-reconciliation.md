# Main / accepted production reconciliation for #28

This is not an issue-only diff against main: the accepted production source
(`63433e9`, newer than the running release `8f6548e`) contains independent
transport, UI, automation, Sources, Memory and safety fixes. They must survive
the shared-extension migration. Original dirty worktrees and immutable releases
are not source-edit targets.

The migration is committed at `9af746e`; main is reconciled as an explicit merge.
Conflicts were inspected by region, followed by an audit of non-conflicting Git
insertions (which otherwise resurrected duplicate functions and old runners).

| Main contribution | Reconciled implementation |
| --- | --- |
| DefaultResourceLoader cwd/agentDir initialization (#12) | Shared headless resource loader receives explicit cwd, agentDir and sessionDir; real SDK discovery/reload regressions pass. |
| Astra SDK/priority provider support (#18) | Coordinated SDK 1.0.0 packages and reviewed shared provider hook replace the inline policy. Future GPT policy is owned by the enabled extension, never a second host hook. |
| Isolated/ephemeral automated prompts (#21) | Storage-key isolation, safe settlement and ephemeral cleanup retained; cron now receives its cancellation signal and a private per-job session. |
| Workspace cron and scheduled UI (#22) | Existing endpoints, jobs.json, JSONL history, UI and timezone semantics retained; shared backend adds persistence, fencing and history. Duplicate route insertions removed. |
| Remote commit review / rollback / watchdog (#19/#20) | Existing safety gates retained; main's clearer Chinese settled-result notifications preserved. |
| README cleanup (`e4e1457`) | Removal of reminders/cron promotional highlights retained; operational API documentation remains. |
| Memory / prompt / skills views | Accepted production read-only Memory UI, correction history, agent/system/archive views and shared shell retained. Main's new SSE watches for core/SYSTEM/SKILL/namespace changes retained, as are public store log-reading helpers. Enabled skill discovery comes from Pi rather than duplicating a harness catalog in the system prompt. |
| Nightly reflection | Claw already has the advanced checkpointed `memory-reflection` domain skill and two reflection-related host cron entries. Keep these untouched and the shared memory write path; do not resurrect the older default-enabled TS scheduler, harness writer or unauthenticated snapshot rollback route. That would create a competing automatic writer/reset owner and regress the accepted deployment. No new reflection/data migration is introduced by #28. |

All live-only capabilities remain, including the cancellation/recovery fences,
final-only reply guard, read-only Sources and current source status fields,
Automation Tasks, PT/site rules, bounded system-summary/history handling and
loopback-only idempotent nightly session reset. The old inline provider and
bounded host goal engine are replaced deliberately by their shared extensions;
legacy goals import paused/blocked and retain their old checkpoint unchanged.

## Release gate

Node 22 host tests and isolated live capability checks are separate from production
acceptance. Messages currently reports `-1743`: its grant names the old Node
22.22.0 executable while launchd runs 22.23.3. The current Node needs user-granted
Automation permission. No TCC mutations, attribution workarounds, production
switch or issue closure are permitted before that is resolved. Main merge must
also wait if the remote-review LaunchAgent could automatically deploy it.

Before deployment, back up actual persistent databases through SQLite backup
(including WAL state), queue, cron config/history, all per-chat goal/session state,
settings and domain skills; keep immutable current/previous release targets.
Use `ops/deploy-detached.sh` with the expected current-release precondition.
Verify its explicit completed/exitCode=0 receipt, post-switch real model probe,
controlled message delivery, preserved state and live extension capabilities.
Only then apply the reversible acceptance-gated tooling cleanup and close #28.
