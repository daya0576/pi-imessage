# Chat-local thinking and long-running task recovery

## Thinking scope

`/thinking max` writes only `<workspace>/<chatGuid>/agent-settings.json`.
`/thinking default` removes that chat's override. `/new`, `/reload`, normal
requests, and isolated completion summaries preserve the override. SDK calls
explicitly pass `persist: false`; global Pi settings remain unchanged. Effective
levels remain bounded by the selected model's capabilities. Runtime status
includes active session thinking levels for operational verification.

Existing releases do not read this file. A deployment (not editing a transcript)
is required to activate this feature. No in-flight inference changes retroactively.

## Timeout behavior

The 120-second sliding idle timeout and independent 30-minute safety ceiling
remain in force. A timeout writes `interrupted-prompt.json` alongside the session
transcript and aborts/detaches the session. Timeout diagnostics stay in internal
logs, not destination messages, including provider timeouts during or after SDK
retries. Late aborted output is ignored. Silence does not mark unfinished work
complete or authorize replay. Non-timeout failure reporting is unchanged. The checkpoint records pending tool names and uncertain
outcomes, not argument payloads or invented success/failure. Transport retries
must not replay a timed-out user prompt. Unknown side effects require inspection
before manual continuation; this is not arbitrary automatic resumption of code.

## Durable background result summaries

Before launching a detached command, the agent registers `watch_background` with:

- a fresh, run-specific completion JSON inside that chat's scratch directory;
- a bounded summary instruction naming the task/result files;
- an optional 1–1440 minute wait deadline (120 minutes by default).

Registration must succeed before launch. The command must atomically rename its
final JSON marker with an explicit terminal `status`: `success`, `completed`,
`failed`, `cancelled`, or `timeout`. `{}`, an unknown status, `pending`, and
`running` are not completion evidence. A terminal marker confirms only that the
producer reported an outcome, not that tests passed or effects were verified.
Do not reuse an old run path. The watcher does not execute or restart commands. Existing valid
markers can be explicitly registered for recovery, but no historical automatic
backfill is performed.

`background.db` persists pending work, read-only summarization state, and a
notification outbox. Only the active worker starts the service. A lifetime SQLite
exclusive lock prevents multiple workers. Restart recovers interrupted read-only
summaries; completed summaries are persisted before delivery so send retries do
not regenerate them. Summary retries are bounded to three; notification retries
to ten, using stable job references and locally verified Messages send status.
This verifies local send state, not recipient delivery or read status. Terminal
failed notifications remain in the database for operator inspection.

Completion summaries run in isolated sessions with only the `read` tool enabled.
They cannot run commands, mutate files, register further watches, or deploy. They
still must treat file contents as untrusted evidence, avoid unrelated private
material, and distinguish command completion from test correctness/effectiveness.
Only a registered watch survives a chat timeout; unregistered shell background
processes are not discovered automatically. This deliberately avoids unsafe
blind replay or assumptions that a still-running process has stopped.

## Shared scheduler backend and host integration

The source of truth is the installed Pi extension's `scheduler/service.cjs`
(and `time.cjs`), under `~/.pi/agent/extensions`. On this development machine that
symlink resolves to `dotfile/pi-config/agent/extensions/scheduler`. Terminal
`index.ts` uses `createSessionScheduler` from that same module: commands, tools,
JSON store format, session pause/resume and immediate first loop iteration remain
unchanged. The terminal adapter does **not** start the service worker.

The module also exports `createServiceBackend({Database, Cron})` with API version
1. Constructors are supplied by the host's installed dependencies so SQLite's
native binding does not need a second installation in dotfile. There are no
import-time timers. `src/background.ts`, `src/reminders.ts`, and `src/cron.ts` are
typed host adapters, not independent scheduler implementations. The host defaults
to the exact vendored snapshot under `src/shared-scheduler` (at runtime,
`dist/shared-scheduler`); a clean npm installation does not require personal Pi
files. `PI_SCHEDULER_SERVICE_PATH` can explicitly select a reviewed external
`service.cjs`. Missing/incompatible artifacts fail closed; no alternate timer
implementation silently starts another scheduler.

Update only the authoritative extension, then run
`node src/shared-scheduler/sync.mjs /path/to/dotfile/pi-config/agent/extensions/scheduler`.
`--check` before the path verifies byte equality and SHA256 provenance against
both repositories. Sync refuses uncommitted canonical source; `provenance.json`
pins its Git commit and all source file hashes. `--check` also verifies those
bytes from the pinned commit; focused tests
verify snapshot integrity and load the exact vendored terminal entry point. The
build copies the complete shared-scheduler resource directory into dist and
TypeScript also compiles its terminal `index.ts`. The `.d.cts` files are source
typing artifacts. Do not edit or format vendored files independently.

`src/scheduler.ts` adds `createSchedulerService` for service-owned delayed/repeating
prompts. `schedule({owner,prompt,fireAt,intervalMs?,idempotencyKey?})` accepts epoch
milliseconds; `parseSchedulerTime`/`parseSchedulerInterval` use the same parsers as
terminal Pi. Stable task IDs, owner-scoped cancellation, persisted attempt IDs,
run history and a lifetime worker fence survive chat/session disposal and process
restart. An overdue loop submits at most one iteration, then advances from the
current time. Submissions carry the same text as terminal Pi: a loop iteration
includes its id and the explicit-stop `cancel_scheduled_task` instruction. `accepted` means the host accepted submission, **not** that the model
finished successfully. A transport that supports idempotency must use `runId`;
without it a crash after submission but before persistence can duplicate a prompt.
The service never resumes an interrupted conversation transcript.

Service integration:

- `main.ts` owns one workspace scheduler. Only the active worker starts it;
  shutdown stops it before closing the chat queue. Session disposal cannot stop it.
- Delivery uses `queue.pushDurable`, atomically persisting acceptance and `runId`
  in the same queue snapshot before waking a consumer. Retries after acceptance,
  including after an ack/restart, cannot enqueue a second copy. The queue keeps the
  most recent 1000 accepted keys; only the latest key per task is ever retried. Disabled chats
  reject submission. Queue acceptance is not successful execution or delivery.
- The service adapter reuses the canonical scheduler's tool definitions but
  suppresses its session timers/commands. Registrations and cancellation are
  chat-owned; tool-call IDs are durable registration idempotency keys. Summary
  sessions have no scheduling tools.
- Cron prompts use an isolated persistent task session and propagate their
  `AbortSignal`. Late output is fenced, and cancellation waits for SDK settlement.
  The backend retains overlap ownership until the callback settles; a truly
  uncooperative callback can still delay shutdown. Shutdown aborts running cron
  callbacks (exec children receive SIGTERM); a settled abort is recorded as a
  failed run, not replayed, and does not block the job.
- `watch_background` guidance requires explicit terminal marker status; summaries
  stay read-only and independent of the originating session.

Cron keeps `cron/jobs.json`, JSONL history and all existing host APIs, while
`cron/scheduler.db` durably records starts, terminal outcomes and next schedule.
Restart marks runs that never settled (crash/SIGKILL) as unknown failures and blocks the job; it does
not replay prompt/exec side effects. A timeout also persists a block until the
callback settles. After a crash, operators must independently verify the old
operation/process ended, stop the worker, and remove that job's row from SQLite's
`blocked` table before rerunning. Enabling/disabling is not an unblock override.
One overdue scheduled occurrence is caught up, not the entire missed backlog.
History imports legacy JSONL once, preserving latest records by run ID.

Reminder and background state/database paths remain compatible with existing
workspaces. Reminder workers now have a lifetime fence too; registration is an
atomic idempotency transaction. A reminder whose send attempt was interrupted by a
crash is marked `failed` (`lastError` says outcome unknown) and is not resent. Background transitions and notification retries
retain a history; delivery receives an optional stable full job ID. This is not
an exactly-once guarantee if the host sender lacks deduplication. Existing ready
summaries and terminal records are retained, not reinterpreted as new watches.

## Validation

Regression coverage includes cross-chat scope, global settings preservation,
create/reload/new behavior, both timeout types, uncertain tool checkpoints,
late-abort suppression, no transport replay, read-only tool allowlists, durable
restart catch-up, incomplete markers, deadlines, singleton fencing, symlink
escapes, bounded failures, and persisted delivery retries.

Private synthetic real-provider smoke tests also verify max-vs-high request
payloads and read-only post-restart summaries of an intentionally failed result.
They never send synthetic messages to production chats. Production rollout and
live activation must be reported separately from these checks.
