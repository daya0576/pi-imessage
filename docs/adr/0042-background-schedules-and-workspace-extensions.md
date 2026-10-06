# 0042. Background schedules and workspace extensions

Status: proposed (consolidates ADRs 0019 and 0032–0035 without changing behavior)

**Problem.** Scheduling was removed (0019), rebuilt natively (0032–0034) and
then separated from personal business code (0035). The current rules are
spread over five ADRs that partly contradict each other.

**Example.** A daily 07:45 workspace task and six-hour compaction both keep
their deadlines across a restart. Changing the task's code changes only
`WORKING_DIR/extensions/<name>/`, not the framework.

**Decision.**

- **Retired services stay removed:** cron, reminders, delayed prompts,
  completion watchers, PT Automation and HTTP `/prompt` / `/send`. Their
  endpoints return 404; stored old data is kept but unused.
- **Workspace extensions** hold personal code: `WORKING_DIR/extensions/<name>/`
  with `index.ts` and `config.json`. Each is a trusted native Durable extension
  with tools, tasks and optional schedules. The owner and the chat assistant
  may both create them. Startup, `/reload` and `reload_extensions` scan direct
  child directories. Duplicate names are rejected; a failed reload keeps the
  old definitions; running calls keep their code.
- **Framework scheduling** gives each schedule a dedicated conversation with a
  background task whose checkpoint saves the absolute next deadline. Each
  occurrence is a child task; occurrences never overlap. Daily slots run only
  today's slot, without backfill; interval slots skip missed ticks. Six-hour
  compaction uses the same mechanism and stays built in.
- **Time** is the service machine's local timezone (or `TZ`). Daily slots are
  computed by calendar date, so daylight-saving changes keep the wall-clock
  time. Saved deadlines are never reset by reload, restart or timezone change.
- **Delivery** commits business state and the outgoing item together. The host
  sends through existing receipts at most once; `unknown` is never resent.
- **Operator run:** `serve --run-scheduled JOB --request-id ID` admits one
  occurrence at startup; repeating the same request ID returns the same task.
- **History:** `/scheduled` shows each schedule, its deadline and the latest
  ten occurrences from native task records. Viewing never starts work.
- **Removal:** removing an extension stops future scheduling only. Unfinished
  work keeps its code in memory; restart fails explicitly if required code is
  missing.

**Consequences.** The service must be running to act at a deadline. Workspace
extensions are trusted code and need backup. This supersedes ADRs 0019 and
0032–0035, and the scheduler clause of ADR 0013.
