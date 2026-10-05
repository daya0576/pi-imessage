# 0018. Ordinary `/stop`; scheduled tasks without HTTP `/prompt` and `/send`

Status: accepted (2026-10-05; owner accepted 2026-10-05). Supersedes proposed [0014](0014-ephemeral-private-storage.md) and [0015](0015-ordinary-stop-keeps-native-inbox.md). Replaces the HTTP `/prompt` clause of proposed [0012](0012-run-in-owned-conversation.md) and the `/send` resend hint of [0003](0003-replies-at-most-once.md).

**Context.** Every production caller of HTTP `/prompt` and `/send` is a script or cron job on the same machine, plus the agent sending files through curl. The work they start runs in a separate context, but its result never reaches the chat's own conversation: when the user replies to a morning summary, the chat does not know what was sent. 0014 and 0015 wait for storage lifecycle work and an upstream Durable API.

**Example.** At 08:00 a cron job runs a script that builds the newsletter prompt; the agent works in its own conversation and sends five links. The user replies "expand the third one". The chat conversation must already hold the five links, not the prompt or tool calls that produced them.

**Decision.**

- **Ordinary `/stop`** (no active `/run`) aborts the generation task that owns the current inputs (`LiveDoc.run`), not the conversation, so later queued messages stay in the inbox. If generation hands the same inputs to a new task meanwhile, abort that one too. Then write a passive `[/stop]` entry so Durable places the queued messages. `/stop` during a run is unchanged.
- **Tasks.** Cron `prompt` jobs, `schedule_task` firings and background summaries each run in a fresh ownerless conversation, keyed by request ID. Nothing carries over between runs; continuity lives in the chat conversation and memory. Transcripts are kept, not deleted. The model health check reuses one conversation.
- **The chat records what was sent.** A delivered task answer, and every service or tool send (reminders, cron `send`, background summaries, Automation, `send_message`), is written to the chat conversation as one passive entry with its delivery status, deduplicated by request ID. No extra model turn; the chat's next turn sees it.
- **No HTTP `/prompt`, `/send` or `ephemeral`.** Cron `send` and `prompt` actions accept an optional `command` (absolute argv). Its stdout replaces the text or prompt; empty output skips the run. Scripts print instead of POSTing, and are scheduled in `cron/jobs.json`. The agent sends files and extra messages with the native `send_message` tool, using the existing direct-send receipts (tool task ID as request ID). Remaining HTTP: read-only pages, reminders, cron management and model health.
- **Cutover.** The old service still needs `/prompt` and `/send`, so production scripts, crontab entries and `jobs.json` change in the same step as the cutover ([0009](0009-one-shot-cutover.md)).

**Consequences.** One way to start agent work from outside a chat, and one place (the chat conversation) that knows what the user saw. `/stop` uses a bounded lookup/abort retry instead of an atomic native operation. Old `ephemeral` deletion is dropped; private tool output stays searchable under `durable/`. External callers on other machines can no longer prompt the agent; a future multi-entry design decides that. The shared scheduler's `jobs.json` parser gains the optional `command` field.

**Rejected.** Handing task results to the chat as input (an extra model turn, interrupts current work, rewrites the sent text). Private per-session storage (0014). Waiting for an upstream cancellation API (0015). Keeping `/prompt` and `/send` as thin HTTP entries.
