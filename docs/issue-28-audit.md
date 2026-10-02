# Issue #28 migration audit

Audit date: 2026-10-02. This is a baseline/gap report, not migration or live acceptance sign-off.

## Source and runtime baseline

- Isolated worktree: `pi-imessage-issue28-finish`, branch `issue-28-finish`, HEAD `63433e9`.
- Original worktree `pi-imessage` contains overlapping uncommitted migration work and remains untouched.
- Claw source checkout: `/Users/clawbot/pi-imessage`, branch `fix/silent-timeouts-delivery-20260920`, HEAD `63433e9`, clean at audit.
- Claw active release: `pi-imessage-0.0.43-8f6548ecf1d0-20260926-224811`. Source HEAD is newer than the running release; these are not equivalent baselines.
- Claw Node: `v22.23.3`. HTTP `/` returned 200; `/health/runtime` returned `ok: true`, zero active prompts, eleven sessions.
- Main and the source baseline diverge. Before migration, `git diff --stat origin/main HEAD` reports 88 files, 9,412 additions and 2,917 deletions. The baseline includes accepted UI, sources, automation, transport and timeout fixes, and removes/replaces old reflection/harness code.
- Read-only `git merge-tree --write-tree HEAD origin/main` reports 13 conflicted files, including agent, main, Tasks, Memory UI and deployment. No merge was applied to the worktree.
- Publishing the current branch includes the accepted live baseline. The user explicitly required compatibility fixes for both baselines; preserve main-only and live-only behavior during reconciliation, document its scope in the PR and do not silently pick one UI wholesale.

## Capability matrix

| Issue row | Present implementation / verification | Remaining acceptance |
| --- | --- | --- |
| Message transport, queues, isolation | Product modules retained; batching, cancellation, queue persistence regressions pass | Live controlled receive/send check, preserve allowlists |
| Provider hook | `headless-extensions.ts` discovers enabled shared `openai-codex-fast`, rejects other imports before load, deduplicates sources; inline hook removed | Claw real-SDK acceptance and release verification |
| Search / fetch | Shared `pi-web-access`; forces raw noninteractive workflow, disables unowned background follow-up, guards result ownership | Real search/fetch on claw; archive obsolete workspace search only after acceptance |
| Goal | Installed `pi-goal-x`, per-chat pool, host-queued checkpoints and native lifecycle commands. Legacy `goal.json` imports via the canonical writer into paused/blocked state, preserving objective/progress/reason/evidence/turn history; unchanged original and durable receipt prevent reimport. Installed-extension tests verify resume once, idle stop, input priority, clear and session reset | Verify migrated live goal remains paused after deployment |
| General browser | Shared npm browser adapter, browser/search aliases deduplicated, private module graphs, headed/attach/discovery denied | Actual Chromium and Node 22 host checks; CLI/skill cleanup after successful smoke |
| Structured memory | Existing change delegates writes to embedded byte-identical shared Python backend; reads are thin TS parsing; 22 regressions pass | Verify provenance vs terminal CLI and live store continuity; no data migration |
| Scheduler / reminders | Shared scheduler snapshot and slim host wrappers; service-owned persistence, occurrence fencing, owner scoping, restart and cancellation settlement tests | Commit authoritative shared source separately, verify production paths and old persisted records before restart |
| Completion events | Shared service backend, explicit terminal status validator, durable delivery; deployment status registered before detach | Live deployment receipt plus restart delivery evidence; marker existence is not success |
| Remote / subagents | Remote rejects this host and namespaces sessions; native Agent adapter is synchronous/private, denies background/schedules/config overrides; six tests pass | Host self-target skip and real installed package acceptance; no remote self-delegation smoke |
| Site browser tasks | Domain skill retained; workspace `browser-task` exists | Preserve PT login evidence, single-submit and credential rules |
| Tool-type skills | Loader filters covered search/browser instructions only after extension loads | Workspace `skills/search` still exists; update persisted job references and archive outside discovery after acceptance |
| Domain skills | Shared enabled domain resources kept for writable chats; read-only summaries exclude all skills | Compare production discovered domain skills before/after |
| TUI / desktop / tmux | Explicitly rejected before factory import; skip audit logs present | Check production logs and multi-chat lifecycle/timer isolation |

## Verification already run

In the isolated worktree, with existing uncommitted migration source:

- `npm run check`: passed, 97 files checked, no diagnostics.
- `npm test`: 38 files, 282 tests passed; installed pi-goal-x test executed, not skipped.
- `npm run build`: passed.
- `npm audit --omit=dev`: zero vulnerabilities.
- `npx tsx ops/acceptance-extensions.mjs`: six offline checks passed with actual local shared config and SDK, simulated model transport; not live search/browser/model evidence.
- `python3 -m unittest discover -s ops -p 'test_deploy_detached.py'`: one test passed.
- All five scheduler snapshot files match SHA256 provenance and the local authoritative dotfile extension byte for byte. Those shared extension edits are still uncommitted.

## Follow-up verification (2026-10-02)

- Mini and claw: typecheck/lint, build, 39 test files / 287 tests passed, including legacy migration and installed-extension resume/pause/clear.
- Claw Node v22.23.3: actual installed extensions passed nine SDK acceptance checks: loaded tool names; provider hook once; reload without duplicates; two-chat isolation; per-chat native goal pools; read-only restriction; private live Chromium contexts; readable IANA fetch; live raw DuckDuckGo search. No production chats or tasks used.
- Authoritative scheduler committed separately in dotfile at `d59ec3c`; five vendored files remain byte-exact, now with commit and SHA256 provenance.
- The standalone shared-config suite has a pre-existing settings assertion for obsolete pi-web-access/subagents pins. Its scheduler-focused test passes; production/application regression tests all pass. Unrelated user settings and goal-host deletions remain unstaged.
- A tiny `example.com` readable-fetch probe was rejected by pi-web-access's incomplete-content heuristic, not by network access. A substantive public IANA page passed readable extraction; raw fetch remains available for short pages.
- Python operations regressions: five tests passed, including detached deployment receipts and acceptance-gated/idempotent skill cleanup preserving embedded prompt payloads and site rules.
- Native goal status works while a model stream hangs; pause cancels it. Bot controls bypass batching, and goal replies retain rich-text, logs and storage. These regressions pass.
- Read-only TCC inspection: Messages AppleEvents grants include Node 22.22.0, but launchd currently executes Node 22.23.3; service logs still report -1743. User was asked to grant the current Node Automation permission. Do not change TCC, evade its attribution or switch production before resolution.
- Published application candidate: draft [PR #29](https://github.com/daya0576/pi-imessage/pull/29), migration `9af746e`, explicit main reconciliation `74ad34a`, CI `47646f4`. macOS/Node 22 CI passed (installed native goal extension exercised), run `36958921056`.
- Canonical scheduler `d59ec3c` is published in [dotfile PR #11](https://github.com/daya0576/dotfile/pull/11); unrelated user settings/goal-host changes remain untouched.
- Shared memory bytes independently match the terminal and both claw CLI locations: SHA256 `df63bf7bc028636803bd7f14914a71d38e569d92006435bfdd71efb66a910dd4`.
- Main/production reconciliation and non-conflicting resurrection/duplicate audit are documented in [the reconciliation ledger](issue-28-reconciliation.md). Post-reconciliation claw check/build/audit, all 287 tests, nine actual-SDK/live checks and production-state clone rehearsal passed again.
- GitHub merge and production switch are deliberately pending user-granted Messages Automation permission, because the remote-review LaunchAgent can deploy new main commits. No restart/deployment or runtime skill cleanup applied; cleanup dry-run finds two legacy references in ten jobs and one obsolete search skill, with all domain/site skills retained.

## Delivery blockers and safety gates

1. Baseline reconciliation is authorized: preserve accepted live source and main-only work, explicitly describe reconciliation in the PR, and resolve conflicts function by function.
2. Existing claw logs contain repeated `Not authorized to send Apple events to Messages. (-1743)` failures, including a failure on 2026-10-02. Health endpoints do not prove Messages send permission. User-granted macOS Automation permission may be required; do not bypass TCC or claim live send success.
3. Legacy goal migration and control/recovery tests now pass. A paused goal must remain paused after live import; unknown operations must not replay.
4. Back up actual persisted scheduler, completion, goal and chat state before deployment. Discover paths from verified implementation/configuration rather than assuming JSON filenames.
5. Deploy only committed clean source through detached blue-green flow with explicit completion registration, shadow probes, idle drain, rollback and post-switch verification. Close #28 only after every row has source/test/live evidence.
