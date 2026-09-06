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
transcript, notifies the destination, and aborts/detaches the session. Late aborted
output is ignored. The checkpoint records pending tool names and uncertain
outcomes, not argument payloads or invented success/failure. Transport retries
must not replay a timed-out user prompt. Unknown side effects require inspection
before manual continuation; this is not arbitrary automatic resumption of code.

## Durable background result summaries

Before launching a detached command, the agent registers `watch_background` with:

- a fresh, run-specific completion JSON inside that chat's scratch directory;
- a bounded summary instruction naming the task/result files;
- an optional 1–1440 minute wait deadline (120 minutes by default).

Registration must succeed before launch. The command must atomically rename its
final JSON marker, including a failure status when appropriate. Do not reuse an
old run path. The watcher does not execute or restart commands. Existing valid
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
