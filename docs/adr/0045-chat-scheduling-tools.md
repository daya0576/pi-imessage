# 0045. Native chat scheduling tools

Status: proposed

**Problem.** A simple deferred chat request currently requires the assistant to
write a trusted workspace extension and reload it. That is useful for reusable
business code, but unnecessarily complex for an ordinary reminder or agent task.

**Example.** In iMessage, "remind me in ten minutes" should create a task through
`schedule_task`, just as it does in the coding agent. "Every day at 09:00,
summarize new items" should not require generated TypeScript either.

**Decision.**

- Add built-in `schedule_task`, `list_scheduled_tasks` and
  `cancel_scheduled_task` tools for chat conversations. The scheduling tool takes
  a time and a prompt, with optional explicit daily or interval repetition.
  Support durations, clock times and absolute datetimes; do not add a cron parser.
- Bind each task to its originating chat in host code. List and cancellation
  operate only on that chat's interactive schedules, never framework maintenance
  or workspace extension schedules. Return a stable ID and the actual deadline.
- Use native Durable background tasks and documents in the existing owning
  service. Creation must be atomic and deduplicated by the scheduling tool call;
  interruption must not create a second schedule. Persist absolute deadlines,
  configuration and cancellation. No detached timer, operating-system scheduler,
  legacy job files, HTTP prompt/send endpoint or second pipeline.
- Execute each occurrence in a fresh isolated agent conversation with the
  normal authorized tools. Send its final result back to the originating chat
  through the existing at-most-once receipts and passive chat records, without
  steering an unrelated active chat turn. A scheduled prompt is a saved user
  request, not a system instruction.
- Recurring occurrences never overlap and skip missed slots. One-shot tasks
  execute once when overdue, including after restart. Cancellation prevents
  future admission; it does not undo an already admitted occurrence or resend
  uncertain effects. Keep existing restart recovery and unknown-send safeguards.
- Use the service machine's timezone, including explicit `TZ`, and expose native
  deadlines and occurrence records on the existing read-only Scheduled page.
  The service must be running to execute work; persistence does not wake a
  stopped service or machine.
- Keep workspace extensions for reusable business tools and tasks. Existing
  extension schedules and six-hour compaction retain their IDs, deadlines and
  behavior. Reload must not disable or reset interactive schedules.
- Replace the chat prompt's extension-writing requirement for ordinary scheduled
  work with brief instructions to use these tools. Do not remove unrelated chat
  steering or delivery safeguards.

**Consequences.** This deliberately replaces ADR 0042's retirement of ordinary
reminders and delayed agent prompts, but not its retired external services or
workspace extension contract. It also replaces that clause of ADR 0018. It is a
small native management interface over Durable, not a return to the old cron
service. Implementation follows owner acceptance; accepted ADRs stay unchanged.
