# 0019. Remove scheduled services from the chat application

Status: proposed

**Problem.** The owner wants scheduling removed from this project and will design
it separately later. Keeping empty job files or startup switches still leaves
scheduled effects and their dependencies in the chat application's lifecycle.

**Example.** Starting messaging must not create reminder databases, register cron
jobs, run PT checks or watch completion files, even when old configuration exists.

**Decision.**

- Remove cron, reminders, delayed/repeating prompts, background completion
  watchers/summaries and PT Automation from source, tools, routes, pages, startup,
  preflight and direct dependencies. Do not replace them with disabled stubs.
- Keep messaging, immediate `send_message`, foreground subagents, `/run`, ordinary
  `/stop`, native task inspection and explicit tool-less model health checks.
  Keep the six-hour context compaction required by ADR 0008; it is a chat
  maintenance timer, not user scheduling.
- Keep existing settings, memory, history, receipts and offline backup/import
  data intact. Removal does not authorize deleting stored job data, modifying
  installed Pi extensions, or changing the operating system's crontab/launchd.
  This application does not manage or stop independent operating-system jobs.
- Removed scheduling and Automation endpoints return 404. There is no
  compatibility adapter or automatic migration to another scheduler.
- Retain historical isolated-conversation metadata for read-only inspection,
  but do not deliver answers from retired scheduled conversations.

This proposal supersedes the scheduled-service clauses of ADR 0013 and ADR 0018
only when accepted. Their ordinary stop, immediate sending and receipt decisions
remain unchanged. Accepted ADR files are not edited. Scope and implementation
progress are tracked in GitHub #33, not in this document.

**Consequences.** A future scheduler needs its own design and approval. Startup
still needs independent old producers to be reviewed, and model/Messages live
acceptance remains separate from removal of scheduled services.

**Rejected.** Merely clearing job definitions, hiding tools while retaining
workers, reviving HTTP `/prompt` or `/send`, and deleting production state as
part of a source-code change.
