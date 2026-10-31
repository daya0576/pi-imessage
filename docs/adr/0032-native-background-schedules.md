# 0032. Native background schedules and read-only execution history

Status: proposed (owner requested native scheduling, compact migration and Web history)

**Problem.** The retired scheduler called HTTP `/prompt`, which no longer exists.
The six-hour maintenance `setInterval` also loses its next deadline on restart.

**Example.** Restart at 07:40 must retain tomorrow's English deadline and the
maintenance deadline, without starting another message pipeline or recreating
uncertain sends. A Web refresh must show both jobs without invoking a model.

**Decision.**

- Register one Durable scheduling extension in the agent layer. Each configured
  job has a dedicated ownerless conversation and a conversation-owned task with
  `background: true`. Its saved `sleep` checkpoint contains the absolute next
  deadline. `runtime.sleep()` is an invocation-local wait, not a persisted timer.
- An occurrence is a child task admitted atomically with the scheduler's waiting
  checkpoint. Join with `allSettled`, then compute the next deadline, including
  after generation failure. Native task records are the execution history; there
  is no separate host worker database or UI execution log.
- Support exactly six-hour chat compaction and the explicitly configured daily
  English card. Keep native compaction, its quiet maintenance progress routing,
  and automatic/manual compaction behavior. No arbitrary cron parser or LLM
  scheduling tools. Do not revive legacy job files, HTTP prompt/send, reminders,
  background completion watchers or PT Automation.
- Daily English uses Asia/Shanghai calendar deadlines. A late start processes
  only the current day after its scheduled time; missed days are not backfilled.
  Compaction processes one overdue tick and skips missed interval slots. Long
  executions never overlap themselves. Configuration is read at startup; existing
  saved deadlines remain, with changed cadence applied to the following slot.
- Import the configured English `used.json` once, read-only, preserving unknown
  fields. Durable owns subsequent learning progress. Code selects due reviews
  and enforces the existing three-expression daily limit and new-learning quota;
  a tool-less, isolated model conversation provides wording, never updates files
  or sends. Commit learning changes, the actual card and its outbox together.
  Per-date card records and stable submission/request IDs prevent regeneration.
- Deliver the outbox using existing direct-send receipts and passive chat records.
  Sending is not transactional with Messages.app. `sending` becomes `unknown` on
  restart; uncertain or previously accepted sends are not automatically replayed.
  Stored learning progress means generated/displayed content, not proof of delivery.
- `/scheduled` and `/scheduled/data` show all native configured schedules, their
  task state/deadline, per-job latest ten occurrence tasks, and the latest ten
  across all jobs. Show generation result separately from delivery receipt. These
  are read-only routes; viewing them never resumes tasks or starts inference.

This proposal supersedes ADR 0013's rejection of native recurring task adapters
and ADR 0019's removal of these two scheduling features only. Other retired
features and at-most-once transport safeguards remain unchanged.

**Consequences.** The service must be running to act at a deadline. Stored
checkpoints recover execution but cannot wake a stopped machine or process.
Schedules remain independent of chat abort/reset. Explicitly aborting their task
pauses them; startup does not silently recreate a terminal scheduler.

**Rejected.** An external cron daemon, a second message pipeline, restoring
`/prompt`, a timer that reschedules from each process startup, asking the model
to remember to schedule tomorrow, and claiming exactly-once external delivery.
