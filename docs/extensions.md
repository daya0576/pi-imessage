# Headless shared capabilities

Issue [#28](https://github.com/daya0576/pi-imessage/issues/28) tracks migration
and live acceptance separately. A source change or an installed package is not
proof that the running service uses it.

## Loading boundary

Read the user's enabled Pi resources, intersect them with reviewed headless
capabilities, and reject other factories **before** import. Keep terminal UI,
desktop notifications, tmux, and session-owned timers out of the service.
Reload must preserve the built-in read/bash/edit/write loadout. Isolated cron
sessions need these tools too; read-only background summaries must retain only
read access.

Provider request hooks run once. Search must not wait for curator UI or request
unowned background follow-up turns. Browser state and web result caches must be
isolated between chats and isolated task sessions. Browser session attachment
and discovery are disabled. Remote requests must reject this host and namespace
remote sessions by the caller's chat/task identity.

## Persistent services

Timers belong to the active service, not to individual conversation lifetimes.
Reminders, recurring execution claims/history, and background completion
registrations survive reload and restart. A shadow worker must not start them.
Preserve existing reminder and scheduled-task HTTP contracts and data paths.
Do not retry an operation with uncertain external effects merely because the
process restarted; do not release overlap ownership until cancellation settles.
Transport delivery is not exactly-once: an acknowledged external send followed
by a local crash can still leave an uncertain receipt.

Completion markers require an explicit settled result; file existence and an
empty JSON object do not prove success. Deployment receipts are registered by
`ops/deploy-detached.sh` before detaching and settle only after the guarded
blue-green deployment exits. See [deployment operations](../ops/README.md).

## Goals

Goals come only from the installed `npm:pi-goal-x` package. It loads only in
normal writable chat sessions; read-only, isolated task and cron sessions skip
it. Each chat keeps its own goal pool under `<chat>/goals`, never the shared
workspace `.pi/goals`. pi-goal-x waits while the chat has queued or running
work. Its checkpoint then runs as an ordinary queued chat turn, and replies obey
the chat allowlist. A checkpoint claimed by a session replaced through `/new`
is dropped. After a restart, interrupted goals pause instead of replaying.
Native lifecycle commands are available without model calls, including while
an ordinary model turn is busy. Mutating controls fence/cancel old work before
native changes; command admission does not block on send settlement. Continuation
replies retain ordinary allowlist, rich-text, digest and chat-log handling.
Commands: `/goal status`,
`pause`, `resume`, `clear`, `list`, `focus`, `unfocus`, plus their `/goal-*`
spellings. `/goal <objective>` maps to the native explicit `goal-direct` command;
guided TUI drafting/settings remain excluded. The exact user clear command is
confirmation for that command only. `/stop` pauses even an idle focused goal.
Legacy `<chat>/goal.json` checkpoints are converted through the installed
extension's canonical writer into paused/blocked goals; objective, progress,
reason, reported evidence and prior turn counts are preserved. No interrupted or
model-reported completed operation is replayed or promoted to verified success.
The original file remains unchanged, and a durable import receipt prevents
recreating a goal after it is archived. An existing native goal retains focus.

## Native subagents

The canonical installed factory and registry load together in a private SDK jiti
graph, using the same `.js` registry specifier as the native factory. Execution
remains the native foreground runner. Only that graph's resource loader is
adapted: isolated children have no extensions, skills, prompts, themes or context
files and resolve no package settings. A missing unrelated CLI/TUI package can
neither block Agent nor trigger a headless installation. Shared settings, process
environment, the SDK singleton and installed source remain unchanged. Tests run
the actual native child twice, verify chat isolation and dispose all timers.

## Acceptance and cleanup

1. Run check, full tests, build and the production dependency audit.
2. Use real SDK sessions to check tool names, provider hook multiplicity,
   two-chat/module-state isolation, reload and read-only restrictions:
   `npx tsx ops/acceptance-extensions.mjs` (stub model, actual shared config).
3. Check restart, concurrent occurrence claims and interrupted-operation history.
4. Verify actual search and a private headless Chromium session on the service host:
   `npx tsx ops/acceptance-extensions.mjs --live`.
5. Rehearse existing state without starting workers:
   `npx tsx ops/acceptance-state.mjs /path/to/actual/workspace` creates private
   SQLite backups/goal copies, verifies compatibility and removes the clone.
   Preview tooling cleanup with `python3 ops/migrate-extension-skills.py
   --workspace /path/to/workspace` (no writes).
6. Commit, use detached blue-green deployment, and verify the resulting release,
   runtime state, model health and explicit deployment receipt. Only after the
   accepted extension release is current, apply tooling cleanup with
   `python3 ops/migrate-extension-skills.py --workspace /path/to/workspace
   --apply --accepted-source <full-commit-SHA>`. This updates references even in
   embedded `/prompt` JSON arguments, keeps job IDs/permissions/state intact,
   and archives tool skills plus a private rollback copy outside discovery.
   Domain skills, PT login/credential rules, memory data and the independent
   `pi-web` UI remain untouched. If rolling back to a pre-extension release,
   restore the archived skill and cron config under stopped scheduler ownership
   before restarting it. Never mark an issue row complete before live acceptance.

The service requires Node.js >=22.22.0; CI and claw exercise that minimum. Dependency lock maintenance and the
npm-published SDK shrinkwrap caveat are documented in [operations](../ops/README.md).
