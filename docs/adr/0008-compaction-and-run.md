# 0008. Compact every 6 hours; `/run` replaces `/goal`

Status: proposed (2026-10-04)

**Context.** The old bot reset every chat nightly, and used `pi-goal-x` for long tasks, which brought task trees, contracts and reviewers we don't need.

**Decision.** Every 6 hours, each chat with new entries since its last compaction is compacted in the background; no chat notifications. Durable's automatic compaction near the context limit stays on. `/run <duration> [task]` keeps the run going through an `onYield` hook until the task is done, the user is needed, or the deadline passes. One run per conversation; `/run-stop`, `/stop` and `/new` end it; it does not survive a restart.

**Consequences.** Context is never wiped on a schedule. `/run` spends tokens until it stops.

**Rejected.** Nightly reset. Migrating `pi-goal-x`.
